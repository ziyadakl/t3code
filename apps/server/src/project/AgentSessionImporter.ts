import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionImportSource,
  AgentSessionScanError,
  AgentSessionSource,
  EventId,
  MessageId,
  type NodeId,
  ProjectId,
  ProviderDriverKind,
  type ProviderThreadId,
  type RunId,
  ThreadId,
  TurnItemId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const IMPORT_EVENT_PREFIX = "agent-session-import:v2";
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

function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

function importedMessageId(threadId: ThreadId, index: number): MessageId {
  return MessageId.make(`${threadId}:${String(index).padStart(6, "0")}`);
}

/** Whether the importer wrote `run` for a transcript prompt, as opposed to a turn run in T3 Code. */
function isImportedRun(threadId: ThreadId, run: OrchestrationV2Run): boolean {
  return run.userMessageId.startsWith(`${threadId}:`) && run.status === "completed";
}

/** One imported Claude prompt and the messages of its turn, by message index. */
interface ImportedTurn {
  readonly ordinal: number;
  readonly userIndex: number;
  readonly lastIndex: number;
  readonly nativeUserMessageId: string;
  readonly nativeTurnId: string;
}

/**
 * Splits a Claude transcript into prompt turns, each to be recorded as a
 * completed run whose provider turn holds the uuids a rewind needs. Empty
 * when any prompt lacks them, since a partial set would rewind to the wrong
 * point.
 */
function importedTurns(
  thread: AgentSessionScanner.AgentSessionThread,
): ReadonlyArray<ImportedTurn> {
  if (thread.source !== "claudeAgent" || thread.messages[0]?.role !== "user") return [];
  const turns: Array<ImportedTurn> = [];
  for (const [index, message] of thread.messages.entries()) {
    if (message.role === "assistant") {
      const current = turns.at(-1);
      if (current !== undefined) turns[turns.length - 1] = { ...current, lastIndex: index };
      continue;
    }
    if (message.nativeUserMessageId === undefined || message.nativeTurnId === undefined) return [];
    turns.push({
      ordinal: turns.length + 1,
      userIndex: index,
      lastIndex: index,
      nativeUserMessageId: message.nativeUserMessageId,
      nativeTurnId: message.nativeTurnId,
    });
  }
  return turns;
}

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: AgentSessionScanner.AgentSessionThreadMessage;
  readonly run?: { readonly runId: RunId; readonly nodeId: NodeId };
  /** Distinguishes the rewrite that moves an already imported message into its run. */
  readonly eventSuffix?: string;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.index + 1;
  const suffix = String(input.index).padStart(6, "0");
  const eventSuffix = input.eventSuffix ?? "";
  const messageId = importedMessageId(input.threadId, input.index);
  const turnItemId = TurnItemId.make(
    `${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`,
  );
  const at = dateTime(input.message.createdAt);
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: input.run?.runId ?? null,
    nodeId: input.run?.nodeId ?? null,
    role: input.message.role,
    text: input.message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: input.run?.runId ?? null,
    nodeId: input.run?.nodeId ?? null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${input.threadId}:${suffix}${eventSuffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    {
      id: EventId.make(
        `${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}${eventSuffix}`,
      ),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: turnItem,
    },
  ];
}

const make = Effect.gen(function* () {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

  /**
   * Events that bring an imported thread's conversation up to `thread`: the
   * messages it does not hold yet and, for a Claude transcript, one completed
   * run per prompt whose provider turn holds the prompt's uuid and the uuid
   * its turn ended at. Records that already match are left alone, so the
   * result is empty once the thread is current.
   */
  const conversationEvents = (input: {
    readonly threadId: ThreadId;
    readonly thread: AgentSessionScanner.AgentSessionThread;
    readonly providerThreadId: ProviderThreadId;
    readonly existing: {
      readonly messageRunIds: ReadonlyMap<MessageId, RunId | null>;
      readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
    };
  }): Array<OrchestrationV2DomainEvent> => {
    const { threadId, thread } = input;
    const driver = ProviderDriverKind.make(thread.source);
    const turns = importedTurns(thread);
    const runIdFor = (ordinal: number) => idAllocator.derive.run({ threadId, ordinal });
    const runOfMessage = new Map<number, { runId: RunId; nodeId: NodeId }>();
    for (const turn of turns) {
      const runId = runIdFor(turn.ordinal);
      const nodeId = idAllocator.derive.rootNode({ runId });
      for (let index = turn.userIndex; index <= turn.lastIndex; index++) {
        runOfMessage.set(index, { runId, nodeId });
      }
    }

    const events: Array<OrchestrationV2DomainEvent> = [];
    for (const [index, message] of thread.messages.entries()) {
      const messageId = importedMessageId(threadId, index);
      const run = runOfMessage.get(index);
      if (!input.existing.messageRunIds.has(messageId)) {
        events.push(...messageEvents({ threadId, index, message, ...(run ? { run } : {}) }));
      } else if (run !== undefined && input.existing.messageRunIds.get(messageId) === null) {
        events.push(...messageEvents({ threadId, index, message, run, eventSuffix: ":run" }));
      }
    }

    const eventId = (...parts: ReadonlyArray<string>) =>
      EventId.make([IMPORT_EVENT_PREFIX, ...parts].join(":"));
    for (const turn of turns) {
      const runId = runIdFor(turn.ordinal);
      const rootNodeId = idAllocator.derive.rootNode({ runId });
      const attemptId = idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
      const providerTurnId = idAllocator.derive.providerTurn({
        driver,
        nativeTurnId: `import:${runId}`,
      });
      const existingTurn = input.existing.providerTurns.find(
        (candidate) => candidate.id === providerTurnId,
      );
      if (
        existingTurn?.nativeTurnRef?.nativeId === turn.nativeTurnId &&
        existingTurn.nativeUserMessageId === turn.nativeUserMessageId
      ) {
        continue;
      }
      const startedAt = dateTime(thread.messages[turn.userIndex]!.createdAt);
      const completedAt = dateTime(thread.messages[turn.lastIndex]!.createdAt);
      const providerTurn: OrchestrationV2ProviderTurn = {
        id: providerTurnId,
        providerThreadId: input.providerThreadId,
        nodeId: rootNodeId,
        runAttemptId: attemptId,
        nativeTurnRef: { driver, nativeId: turn.nativeTurnId, strength: "strong" },
        nativeUserMessageId: turn.nativeUserMessageId,
        ordinal: turn.ordinal,
        status: "completed",
        startedAt,
        completedAt,
      };
      const run: OrchestrationV2Run = {
        id: runId,
        threadId,
        ordinal: turn.ordinal,
        providerInstanceId: thread.providerInstanceId,
        modelSelection: {
          instanceId: thread.providerInstanceId,
          model: thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL,
        },
        providerThreadId: input.providerThreadId,
        userMessageId: importedMessageId(threadId, turn.userIndex),
        rootNodeId,
        activeAttemptId: attemptId,
        status: "completed",
        requestedAt: startedAt,
        startedAt,
        completedAt,
        checkpointId: null,
        contextHandoffId: null,
      };
      const providerTurnEvent = {
        id: eventId("provider-turn", runId, turn.nativeTurnId),
        type: "provider-turn.updated",
        threadId,
        runId,
        driver,
        occurredAt: completedAt,
        payload: providerTurn,
      } as const;
      // The transcript grew the last turn: only its end moves.
      if (existingTurn !== undefined) {
        events.push(
          {
            id: eventId("run", runId, turn.nativeTurnId),
            type: "run.updated",
            threadId,
            runId,
            occurredAt: completedAt,
            payload: run,
          },
          providerTurnEvent,
        );
        continue;
      }
      events.push(
        {
          id: eventId("run", runId),
          type: "run.created",
          threadId,
          runId,
          occurredAt: startedAt,
          payload: run,
        },
        {
          id: eventId("run-attempt", runId),
          type: "run-attempt.created",
          threadId,
          runId,
          occurredAt: startedAt,
          payload: {
            id: attemptId,
            nativeThreadId: thread.providerSessionId,
            runId,
            attemptOrdinal: 1,
            rootNodeId,
            providerInstanceId: thread.providerInstanceId,
            providerThreadId: input.providerThreadId,
            providerTurnId,
            reason: "initial",
            status: "completed",
            startedAt,
            completedAt,
          },
        },
        {
          id: eventId("node", runId),
          type: "node.updated",
          threadId,
          runId,
          nodeId: rootNodeId,
          occurredAt: startedAt,
          payload: {
            id: rootNodeId,
            threadId,
            runId,
            parentNodeId: null,
            rootNodeId,
            kind: "root_turn",
            status: "completed",
            countsForRun: true,
            providerThreadId: input.providerThreadId,
            providerTurnId,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt,
            completedAt,
          },
        },
        providerTurnEvent,
      );
    }
    return events;
  };

  /**
   * Write one transcript's conversation as a settled T3 Code thread bound to the
   * provider's native session, so the next turn resumes it. Returns false when the
   * thread was already imported and only the transcript identity was refreshed.
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
  }) {
    const { thread, source, threadId } = input;
    if (
      thread.source === "claudeAgent" &&
      !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
    ) {
      return yield* new AgentSessionUnresumableSessionError({
        source: thread.source,
        providerSessionId: thread.providerSessionId,
      });
    }
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
      yield* runtimes.recordImportedTranscript({ threadId, source });
      return false;
    }

    const driver = ProviderDriverKind.make(thread.source);
    const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
    const providerThreadId = idAllocator.derive.providerThread({
      driver,
      nativeThreadId: thread.providerSessionId,
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
      runtimeMode: DEFAULT_RUNTIME_MODE,
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
        nativeId: thread.providerSessionId,
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

    yield* runtimes.upsert(
      {
        threadId,
        providerName: driver,
        providerInstanceId: thread.providerInstanceId,
        adapterKey: driver,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        status: "stopped",
        lastSeenAt: thread.updatedAt,
        resumeCursor:
          thread.source === "codex"
            ? { threadId: thread.providerSessionId }
            : { threadId, resume: thread.providerSessionId },
        runtimePayload: { cwd: input.workspaceRoot },
      },
      { onConflict: "ignore" },
    );
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
          type: "thread.created",
          threadId,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: createdAt,
          payload: appThread,
        },
        ...conversationEvents({
          threadId,
          thread,
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
    yield* runtimes.recordImportedTranscript({ threadId, source });
    return true;
  });

  /**
   * An imported thread's records, while no turn has run on it in T3 Code and
   * none of its imported prompts was rewound.
   */
  const untouchedImport = Effect.fn("untouchedAgentImportV2")(function* (threadId: ThreadId) {
    const existing = yield* Effect.option(
      orchestrator.getThreadRecords(threadId, [
        "runs",
        "messages",
        "providerThreads",
        "providerTurns",
      ]),
    );
    return Option.filter(
      existing,
      (records) =>
        records.thread.historyOrigin === "v1_import" &&
        records.thread.deletedAt === null &&
        records.runs.every((run) => isImportedRun(threadId, run)),
    );
  });

  /** Brings an untouched import up to `thread`. Returns the number of messages added. */
  const syncImport = Effect.fn("syncAgentImportV2")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: AgentSessionScanner.AgentSessionThread;
    readonly records: Option.Option.Value<Effect.Success<ReturnType<typeof untouchedImport>>>;
  }) {
    const { threadId, thread, records } = input;
    const known = records.messages.length;
    const providerThread = records.providerThreads.find(
      (candidate) => candidate.id === records.thread.activeProviderThreadId,
    );
    const events =
      providerThread === undefined
        ? thread.messages
            .slice(known)
            .flatMap((message, offset) =>
              messageEvents({ threadId, index: known + offset, message }),
            )
        : conversationEvents({
            threadId,
            thread,
            providerThreadId: providerThread.id,
            existing: {
              messageRunIds: new Map(
                records.messages.map((message) => [message.id, message.runId]),
              ),
              providerTurns: records.providerTurns,
            },
          });
    const turnCount = importedTurns(thread).length;
    if (
      providerThread !== undefined &&
      turnCount > 0 &&
      providerThread.lastRunOrdinal !== turnCount
    ) {
      events.push({
        id: EventId.make(
          `${IMPORT_EVENT_PREFIX}:provider-thread:${providerThread.id}:runs:${turnCount}`,
        ),
        type: "provider-thread.updated",
        threadId,
        driver: providerThread.driver,
        providerInstanceId: providerThread.providerInstanceId,
        occurredAt: dateTime(thread.updatedAt),
        payload: { ...providerThread, firstRunOrdinal: 1, lastRunOrdinal: turnCount },
      });
    }
    if (events.length > 0) yield* eventSink.write({ events });
    return Math.max(0, thread.messages.length - known);
  });

  /**
   * Append the messages a transcript gained since `threadId` was imported from
   * it. Only a thread that never ran a turn in T3 Code is refreshed: once it
   * has, T3 Code's copy of the session is the one being continued. Returns the
   * number of messages appended.
   */
  const appendImportedMessages = Effect.fn("appendImportedAgentMessagesV2")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: AgentSessionScanner.AgentSessionThread;
    readonly source: AgentSessionImportSource;
  }) {
    const { threadId } = input;
    const existing = yield* untouchedImport(threadId);
    if (Option.isNone(existing)) return 0;
    const added = yield* syncImport({ threadId, thread: input.thread, records: existing.value });
    yield* runtimes.recordImportedTranscript({ threadId, source: input.source });
    return added;
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
        const threadId = ThreadId.make(
          `import:${source.providerInstanceId}:${source.providerSessionId}`,
        );
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
        }).pipe(
          Effect.as(true),
          Effect.catch((cause) =>
            Effect.logWarning("Could not import an agent session", {
              provider: outcome.thread.source,
              sessionId: outcome.thread.providerSessionId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (imported) {
          importedThreadIds.add(threadId);
          importedCount += 1;
        } else {
          skippedCount += 1;
        }
      }),
    );

    return { importedCount, skippedCount } satisfies AgentSessionImportResult;
  });

  return {
    importRecentAgentThreads,
    importThread,
    appendImportedMessages,
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
