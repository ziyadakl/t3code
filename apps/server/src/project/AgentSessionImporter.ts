import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  isRuntimeModeAbove,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionImportSource,
  AgentSessionScanError,
  AgentSessionSource,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import { importedThreadId, importedTurns, isImportedRun } from "./ImportedClaudeTranscript.ts";
import {
  dateTime,
  IMPORT_EVENT_PREFIX,
  make as makeImportedThreadRecords,
} from "./ImportedThreadRecords.ts";
import * as ProjectService from "./ProjectService.ts";

const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decodeImportedTranscriptPayload = Schema.decodeUnknownOption(
  Schema.Struct({
    cwd: Schema.optional(Schema.String),
    importedTranscripts: Schema.optional(Schema.Array(AgentSessionImportSource)),
  }),
);

class AgentSessionUnresumableSessionError extends Schema.TaggedError<AgentSessionUnresumableSessionError>()(
  "AgentSessionUnresumableSessionError",
  {
    source: AgentSessionSource,
    providerSessionId: Schema.String,
  },
) {
  override get message(): string {
    return `Session '${this.providerSessionId}' from '${this.source}' cannot be resumed.`;
  }
}

class AgentSessionThreadProjectConflictError extends Schema.TaggedError<AgentSessionThreadProjectConflictError>()(
  "AgentSessionThreadProjectConflictError",
  {
    threadId: ThreadId,
    expectedProjectId: ProjectId,
    actualProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' belongs to project '${this.actualProjectId}', not '${this.expectedProjectId}'.`;
  }
}

class AgentSessionThreadModifiedError extends Schema.TaggedError<AgentSessionThreadModifiedError>()(
  "AgentSessionThreadModifiedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' already contains non-imported activity.`;
  }
}

/** The transcript a provider session runtime row was last imported from, if any. */
export function latestImportedTranscript(
  runtimePayload: unknown,
): AgentSessionImportSource | undefined {
  const payload = decodeImportedTranscriptPayload(runtimePayload);
  return Option.isSome(payload) ? payload.value.importedTranscripts?.at(-1) : undefined;
}

const make = Effect.gen(function* () {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const ceiling = settingsService.managedPolicy?.limits?.maxRuntimeMode;
  const threadRecords = yield* makeImportedThreadRecords;

  // Imports run in full access, except under a policy ceiling: then in the project's default,
  // which the policy keeps under it, so imported threads never sit above the ceiling.
  const importRuntimeMode = Effect.fn("agentImportRuntimeModeV2")(function* (
    projectId: ProjectId,
    knownProject?: Parameters<typeof resolveProjectSettings>[2],
  ) {
    if (ceiling === undefined) return DEFAULT_RUNTIME_MODE;
    const project =
      knownProject ??
      Option.getOrNull(
        yield* projects
          .getById(projectId)
          .pipe(
            Effect.mapError(
              (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
            ),
          ),
      );
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-settings", cause })),
    );
    const mode = resolveProjectSettings(settings, projectId, project).settings.defaultRuntimeMode;
    return isRuntimeModeAbove(mode, ceiling) ? ceiling : mode;
  });

  /**
   * Write one transcript's conversation as a settled T3 Code thread bound to the
   * provider's native session, so the next turn resumes it. Returns false when the
   * thread was already imported and only the transcript identity was refreshed, and null
   * when `skipIfNativeOwned` found the native session owned by another thread.
   */
  const importThread = Effect.fn("importAgentThreadV2")(function* (input: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
    readonly threadId: ThreadId;
    readonly thread: AgentSessionScanner.AgentSessionThread;
    readonly source: AgentSessionImportSource;
    /** Existing worktree the session ran in; the thread runs there when set. */
    readonly worktreePath?: string;
    /**
     * Keep the thread in the active list, sorted as if it last became active
     * at this time, instead of importing it settled.
     */
    readonly activeAt?: DateTime.Utc;
    /** Write nothing, and return null, when another thread already owns the native session. */
    readonly skipIfNativeOwned?: boolean;
    /** The bulk import resolves this once per project; other callers leave it to the import. */
    readonly runtimeMode?: OrchestrationV2AppThread["runtimeMode"];
  }) {
    const { thread, source, threadId } = input;
    const runtimeMode = input.runtimeMode ?? (yield* importRuntimeMode(input.projectId));
    if (
      thread.source === "claudeAgent" &&
      !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
    ) {
      return yield* new AgentSessionUnresumableSessionError({
        source: thread.source,
        providerSessionId: thread.providerSessionId,
      });
    }
    const driver = ProviderDriverKind.make(thread.source);
    // Pi resumes by session file path; its session UUID only names the thread.
    const nativeThreadId = thread.source === "pi" ? source.filePath : thread.providerSessionId;
    const persistRuntime = runtimes.upsert(
      {
        threadId,
        providerName: driver,
        providerInstanceId: thread.providerInstanceId,
        adapterKey: driver,
        runtimeMode,
        status: "stopped",
        lastSeenAt: thread.updatedAt,
        resumeCursor:
          thread.source === "claudeAgent"
            ? { threadId, resume: thread.providerSessionId }
            : { threadId: nativeThreadId },
        runtimePayload: { cwd: input.workspaceRoot },
      },
      { onConflict: "ignore" },
    );
    const existing = yield* Effect.option(orchestrator.getThreadRecords(threadId, []));
    if (Option.isSome(existing)) {
      if (existing.value.thread.projectId !== input.projectId) {
        return yield* new AgentSessionThreadProjectConflictError({
          threadId,
          expectedProjectId: input.projectId,
          actualProjectId: existing.value.thread.projectId,
        });
      }
      if (existing.value.thread.historyOrigin !== "v1_import") {
        return yield* new AgentSessionThreadModifiedError({ threadId });
      }
      yield* persistRuntime;
      yield* runtimes.recordImportedTranscript({ threadId, source });
      return false;
    }

    const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
    const providerThreadId = idAllocator.derive.providerThread({
      driver,
      providerInstanceId: thread.providerInstanceId,
      nativeThreadId,
    });
    const createdAt = dateTime(thread.createdAt);
    const updatedAt = dateTime(thread.updatedAt);
    const turnCount = importedTurns(thread).length;
    const appThread: OrchestrationV2AppThread = {
      createdBy: "system",
      creationSource: "server",
      id: threadId,
      projectId: input.projectId,
      title: thread.title.trim() === "" ? "Untitled thread" : thread.title,
      providerInstanceId: thread.providerInstanceId,
      modelSelection: { instanceId: thread.providerInstanceId, model },
      runtimeMode,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: input.worktreePath ?? null,
      linkedPullRequest: null,
      branchPullRequest: null,
      activeProviderThreadId: providerThreadId,
      historyOrigin: "v1_import",
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
      },
      forkedFrom: null,
      createdAt,
      updatedAt,
      archivedAt: null,
      ...(input.activeAt === undefined
        ? { settledOverride: "settled", settledAt: updatedAt, unsettledAt: null }
        : { settledOverride: "active", settledAt: null, unsettledAt: input.activeAt }),
      snoozedUntil: null,
      snoozedAt: null,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const providerThread: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver,
      providerInstanceId: thread.providerInstanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: {
        driver,
        nativeId: nativeThreadId,
        strength: "strong",
      },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: turnCount === 0 ? null : 1,
      lastRunOrdinal: turnCount === 0 ? null : turnCount,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      createdAt,
      updatedAt,
    };

    const committed = yield* eventSink.write({
      ...(input.skipIfNativeOwned === true ? { unlessNativeThreadOwned: providerThread } : {}),
      events: [
        {
          id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
          type: "thread.created",
          threadId,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: createdAt,
          payload: appThread,
        },
        ...(thread.omittedMessageCount > 0
          ? [
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:history-truncated:${threadId}`),
                type: "turn-item.updated" as const,
                threadId,
                occurredAt: createdAt,
                payload: {
                  id: TurnItemId.make(`${IMPORT_EVENT_PREFIX}:history-truncated:${threadId}`),
                  threadId,
                  runId: null,
                  nodeId: null,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 0,
                  status: "completed" as const,
                  title: null,
                  startedAt: createdAt,
                  completedAt: createdAt,
                  updatedAt: createdAt,
                  type: "system_notice" as const,
                  message: `${thread.omittedMessageCount} earlier ${thread.omittedMessageCount === 1 ? "message was" : "messages were"} not imported. This thread keeps the first user message and the most recent history. The original session transcript is unchanged.`,
                },
              },
            ]
          : []),
        ...threadRecords.conversationEvents({
          threadId,
          thread,
          turns: importedTurns(thread),
          runOrdinalBase: 0,
          providerTurnOrdinalBase: 0,
          providerThreadId,
          existing: { messageRunIds: new Map(), providerTurns: [] },
        }),
        {
          id: EventId.make(`${IMPORT_EVENT_PREFIX}:provider-thread:${providerThreadId}`),
          type: "provider-thread.updated",
          threadId,
          driver,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: updatedAt,
          payload: providerThread,
        },
      ],
    });
    // Bulk import only: a thread started in T3 Code already owns this native session.
    if (input.skipIfNativeOwned === true && committed.length === 0) return null;
    yield* persistRuntime;
    yield* runtimes.recordImportedTranscript({ threadId, source });
    return true;
  });

  /**
   * An imported thread's records, while no turn has run on it in T3 Code and
   * none of its imported prompts was rewound.
   */
  const untouchedImport = Effect.fn("untouchedAgentImportV2")(function* (threadId: ThreadId) {
    return Option.filter(yield* threadRecords.importRecords(threadId), (records) =>
      records.runs.every((run) => isImportedRun(threadId, run)),
    );
  });

  /**
   * Appends the messages a transcript gained since `threadId` was imported from it. `thread`
   * is a read of the whole transcript. Only a thread that never ran a turn in T3 Code is
   * refreshed. Returns the number of messages appended.
   */
  const appendImportedMessages = Effect.fn("appendImportedAgentMessagesV2")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: AgentSessionScanner.AgentSessionThread;
    readonly source: AgentSessionImportSource;
  }) {
    const { threadId } = input;
    const existing = yield* untouchedImport(threadId);
    if (Option.isNone(existing)) return 0;
    const { appended } = yield* threadRecords.syncImport({
      threadId,
      thread: input.thread,
      records: existing.value,
      append: true,
    });
    yield* runtimes.recordImportedTranscript({ threadId, source: input.source });
    return appended;
  });

  const importRecentAgentThreads = Effect.fn("importRecentAgentThreadsV2")(function* (
    input: AgentSessionImportInput,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (
      input.expectedWorkspaceRoot !== undefined &&
      normalizeProjectPathForComparison(project.workspaceRoot) !==
        normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
    ) {
      return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
    }
    const runtimeMode = yield* importRuntimeMode(input.projectId, project);
    const runtimeRows = yield* runtimes
      .list()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    const completedSources = runtimeRows.flatMap((runtime) => {
      const payload = decodeImportedTranscriptPayload(runtime.runtimePayload);
      if (
        Option.isNone(payload) ||
        payload.value.cwd === undefined ||
        normalizeProjectPathForComparison(payload.value.cwd) !==
          normalizeProjectPathForComparison(project.workspaceRoot)
      ) {
        return [];
      }
      return payload.value.importedTranscripts ?? [];
    });
    const outcomes = scanner.recentThreads(project.workspaceRoot, completedSources);
    const importedThreadIds = new Set<ThreadId>();
    let importedCount = 0;
    let skippedCount = 0;

    yield* Stream.runForEach(outcomes, (outcome) =>
      Effect.gen(function* () {
        if (outcome._tag === "Skipped") {
          skippedCount += 1;
          return;
        }
        const source = outcome.source;
        const threadId = importedThreadId(source);
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          importedCount += 1;
          return;
        }
        if (outcome._tag === "Duplicate") {
          if (importedThreadIds.has(threadId)) {
            yield* runtimes.recordImportedTranscript({ threadId, source }).pipe(Effect.ignore);
          }
          return;
        }

        const imported = yield* importThread({
          projectId: input.projectId,
          workspaceRoot: project.workspaceRoot,
          threadId,
          thread: outcome.thread,
          source,
          skipIfNativeOwned: true,
          runtimeMode,
        }).pipe(
          Effect.map((result) => (result === null ? null : true)),
          Effect.catch((cause) =>
            Effect.logWarning("Could not import an agent session", {
              provider: outcome.thread.source,
              sessionId: outcome.thread.providerSessionId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (imported === true) {
          importedThreadIds.add(threadId);
          importedCount += 1;
        } else if (imported === false) {
          skippedCount += 1;
        }
      }),
    );

    return { importedCount, skippedCount } satisfies AgentSessionImportResult;
  });

  return {
    importRecentAgentThreads,
    importThread: (input: Omit<Parameters<typeof importThread>[0], "skipIfNativeOwned">) =>
      importThread(input).pipe(Effect.map((imported) => imported === true)),
    appendImportedMessages,
    healImportedThread: threadRecords.healImportedThread,
    isUntouchedImport: (threadId: ThreadId) =>
      untouchedImport(threadId).pipe(Effect.map(Option.isSome)),
  };
});

type AgentSessionImporterShape = Effect.Success<typeof make>;

export class AgentSessionImporter extends Context.Service<
  AgentSessionImporter,
  AgentSessionImporterShape
>()("t3/project/AgentSessionImporter") {}

export const layer = Layer.effect(AgentSessionImporter, make);
