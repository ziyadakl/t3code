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

import { isImportedTranscriptRun } from "../orchestration-v2/ThreadRewindTargets.ts";
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

const IMPORTED_THREAD_PREFIX = "import:";

/** The thread an agent session is imported into, one per provider session. */
export function importedThreadId(session: {
  readonly providerInstanceId: string;
  readonly providerSessionId: string;
}): ThreadId {
  return ThreadId.make(
    `${IMPORTED_THREAD_PREFIX}${session.providerInstanceId}:${session.providerSessionId}`,
  );
}

/** Whether `threadId` was made by `importedThreadId`, not started in T3 Code. */
export function isImportedThreadId(threadId: ThreadId): boolean {
  return threadId.startsWith(IMPORTED_THREAD_PREFIX);
}

/** The transcript a provider session runtime row was last imported from, if any. */
export function latestImportedTranscript(
  runtimePayload: unknown,
): AgentSessionImportSource | undefined {
  const payload = decodeImportedTranscriptPayload(runtimePayload);
  return Option.isSome(payload) ? payload.value.importedTranscripts?.at(-1) : undefined;
}

function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

/** Starts with the thread id, which is how `isImportedTranscriptRun` tells imported runs apart. */
function importedMessageId(threadId: ThreadId, index: number): MessageId {
  return MessageId.make(`${threadId}:${String(index).padStart(6, "0")}`);
}

/** Whether `run` is a transcript prompt the importer wrote that was not rewound since. */
function isImportedRun(threadId: ThreadId, run: OrchestrationV2Run): boolean {
  return run.threadId === threadId && isImportedTranscriptRun(run) && run.status === "completed";
}

const SETTLED_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

/** One imported Claude prompt and the messages of its turn, by message index. */
interface ImportedTurn {
  readonly userIndex: number;
  readonly lastIndex: number;
  readonly nativeUserMessageId: string;
  readonly nativeTurnId: string;
  /** Where a rewind to before the first turn resumes, when its prompt is not the transcript's first. */
  readonly nativeResumeAt?: string;
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
      userIndex: index,
      lastIndex: index,
      nativeUserMessageId: message.nativeUserMessageId,
      nativeTurnId: message.nativeTurnId,
    });
  }
  return turns;
}

/** A message of an imported thread and the transcript line it is, when known for certain. */
interface PlacedMessage {
  readonly message: AgentSessionScanner.AgentSessionThreadMessage;
  readonly transcriptIndex: number | undefined;
}

/**
 * Finds each stored message of an import in its whole transcript: by the
 * prompt uuid its run already recorded, otherwise by role, text and time.
 * Matches must keep the stored order. A message that matches no line, several
 * lines, or a line out of order stays unplaced, and `unplaced` says why.
 */
function placeStoredMessages(
  stored: ReadonlyArray<{
    readonly id: MessageId;
    readonly message: AgentSessionScanner.AgentSessionThreadMessage;
    readonly nativeUserMessageId: string | undefined;
  }>,
  transcript: ReadonlyArray<AgentSessionScanner.AgentSessionThreadMessage>,
): {
  readonly placed: ReadonlyArray<PlacedMessage>;
  readonly unplaced: ReadonlyArray<{ readonly messageId: MessageId; readonly reason: string }>;
} {
  const keyOf = (message: AgentSessionScanner.AgentSessionThreadMessage) =>
    `${message.role}\n${Date.parse(message.createdAt)}\n${message.text}`;
  const linesByKey = new Map<string, Array<number>>();
  const lineByUuid = new Map<string, number>();
  transcript.forEach((message, index) => {
    const key = keyOf(message);
    linesByKey.set(key, [...(linesByKey.get(key) ?? []), index]);
    if (message.nativeUserMessageId !== undefined)
      lineByUuid.set(message.nativeUserMessageId, index);
  });
  const storedPerKey = new Map<string, number>();
  for (const { message } of stored) {
    storedPerKey.set(keyOf(message), (storedPerKey.get(keyOf(message)) ?? 0) + 1);
  }
  const unplaced: Array<{ readonly messageId: MessageId; readonly reason: string }> = [];
  let previous = -1;
  const placed = stored.map(({ id, message, nativeUserMessageId }): PlacedMessage => {
    const key = keyOf(message);
    const byUuid =
      nativeUserMessageId === undefined ? undefined : lineByUuid.get(nativeUserMessageId);
    const candidates =
      nativeUserMessageId !== undefined
        ? byUuid !== undefined && keyOf(transcript[byUuid]!) === key
          ? [byUuid]
          : []
        : (storedPerKey.get(key) ?? 0) > 1
          ? undefined
          : (linesByKey.get(key) ?? []);
    const reason =
      candidates === undefined
        ? "the thread holds it more than once"
        : candidates.length === 0
          ? "no transcript line matches it"
          : candidates.length > 1
            ? `it matches ${candidates.length} transcript lines`
            : candidates[0]! <= previous
              ? "its transcript line comes before the previous message's"
              : undefined;
    if (reason !== undefined) {
      unplaced.push({ messageId: id, reason });
      return { message, transcriptIndex: undefined };
    }
    previous = candidates![0]!;
    return { message, transcriptIndex: previous };
  });
  return { placed, unplaced };
}

/**
 * The turns of an import whose messages are placed in their whole Claude
 * transcript: one per placed prompt. A turn holds every message up to the
 * next placed prompt, so messages the thread never showed or could not place
 * stay with the turn Claude's session has them in, and it ends at the
 * transcript's last reply before that prompt, or before line `endBefore` for
 * the last turn. Placed messages before the first placed prompt get no turn.
 * When that prompt is not the transcript's first, its turn keeps where the
 * transcript before it ends, so a rewind to it resumes there instead of
 * starting the session over.
 */
function placedTurns(
  placed: ReadonlyArray<PlacedMessage>,
  transcript: ReadonlyArray<AgentSessionScanner.AgentSessionThreadMessage>,
  endBefore: number,
): ReadonlyArray<ImportedTurn> {
  const isPrompt = (index: number | undefined) =>
    index !== undefined &&
    transcript[index]?.role === "user" &&
    transcript[index].nativeUserMessageId !== undefined;
  // Where a session resumed just after the turn of the prompt at `index` continues.
  const resumeIdAt = (index: number) =>
    transcript[index]!.nativeTurnId ?? transcript[index]!.nativeUserMessageId!;
  const firstPrompt = transcript.findIndex((message) => message.role === "user");
  if (!isPrompt(firstPrompt)) return [];
  const starts = placed.flatMap((entry, index) => (isPrompt(entry.transcriptIndex) ? [index] : []));
  if (starts.length === 0) return [];
  // The transcript's turn before the first placed prompt ends where its session resumes.
  let prior = placed[starts[0]!]!.transcriptIndex! - 1;
  while (prior >= 0 && !isPrompt(prior)) prior -= 1;
  const nativeResumeAt = prior < 0 ? undefined : resumeIdAt(prior);
  return starts.map((userIndex, turn) => {
    const next = starts[turn + 1];
    let end = (next === undefined ? endBefore : placed[next]!.transcriptIndex!) - 1;
    while (!isPrompt(end)) end -= 1;
    const prompt = transcript[placed[userIndex]!.transcriptIndex!]!;
    return {
      userIndex,
      lastIndex: next === undefined ? placed.length - 1 : next - 1,
      nativeUserMessageId: prompt.nativeUserMessageId!,
      nativeTurnId: resumeIdAt(end),
      ...(turn === 0 && nativeResumeAt !== undefined ? { nativeResumeAt } : {}),
    };
  });
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
    readonly turns: ReadonlyArray<ImportedTurn>;
    /** Turn `n` (from 1) gets run ordinal `runOrdinalBase + n`. */
    readonly runOrdinalBase: number;
    readonly providerTurnOrdinalBase: number;
    readonly providerThreadId: ProviderThreadId;
    readonly existing: {
      readonly messageRunIds: ReadonlyMap<MessageId, RunId | null>;
      readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
    };
  }): Array<OrchestrationV2DomainEvent> => {
    const { threadId, thread } = input;
    const driver = ProviderDriverKind.make(thread.source);
    const turns = input.turns.map((turn, index) => ({
      ...turn,
      ordinal: input.runOrdinalBase + index + 1,
      providerTurnOrdinal: input.providerTurnOrdinalBase + index + 1,
    }));
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
        existingTurn.nativeUserMessageId === turn.nativeUserMessageId &&
        existingTurn.nativeResumeAt === turn.nativeResumeAt
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
        ...(turn.nativeResumeAt === undefined ? {} : { nativeResumeAt: turn.nativeResumeAt }),
        ordinal: turn.providerTurnOrdinal,
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
    yield* runtimes.recordImportedTranscript({ threadId, source });
    return true;
  });

  /** An imported thread's records, while it is not deleted. */
  const importRecords = Effect.fn("agentImportRecordsV2")(function* (threadId: ThreadId) {
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
        records.thread.historyOrigin === "v1_import" && records.thread.deletedAt === null,
    );
  });
  type ImportRecords = Option.Option.Value<Effect.Success<ReturnType<typeof importRecords>>>;

  /**
   * An imported thread's records, while no turn has run on it in T3 Code and
   * none of its imported prompts was rewound.
   */
  const untouchedImport = Effect.fn("untouchedAgentImportV2")(function* (threadId: ThreadId) {
    return Option.filter(yield* importRecords(threadId), (records) =>
      records.runs.every((run) => isImportedRun(threadId, run)),
    );
  });

  /**
   * Brings an import up to `thread`, a read of its whole transcript: places
   * the messages the thread holds in the transcript, appends the ones after
   * them when `append`, and records a run per placed prompt. Runs T3 Code ran
   * are left as they are; the imported ones go before them in the
   * conversation, so the last imported turn ends where T3 Code's first turn
   * starts in the transcript. Returns the messages appended and whether runs
   * were recorded.
   */
  const syncImport = Effect.fn("syncAgentImportV2")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: AgentSessionScanner.AgentSessionThread;
    readonly records: ImportRecords;
    readonly append: boolean;
  }) {
    const { threadId, thread, records } = input;
    const transcript = thread.messages;
    const importedRuns = records.runs.filter(isImportedTranscriptRun);
    const nativeRuns = records.runs
      .filter((run) => !isImportedTranscriptRun(run))
      .toSorted((left, right) => left.ordinal - right.ordinal);
    const promptUuidOf = (run: OrchestrationV2Run | undefined) =>
      run === undefined
        ? undefined
        : records.providerTurns.find((turn) => turn.nodeId === run.rootNodeId)?.nativeUserMessageId;
    const importedRunByMessage = new Map(importedRuns.map((run) => [run.userMessageId, run]));
    const stored = records.messages
      .filter(
        (message) =>
          message.id.startsWith(`${threadId}:`) &&
          (message.role === "user" || message.role === "assistant"),
      )
      .toSorted((left, right) => left.id.localeCompare(right.id))
      .map((message) => ({
        id: message.id,
        message: {
          role: message.role === "user" ? ("user" as const) : ("assistant" as const),
          text: message.text,
          createdAt: DateTime.formatIso(message.createdAt),
        },
        nativeUserMessageId: promptUuidOf(importedRunByMessage.get(message.id)),
      }));
    const { placed, unplaced } = placeStoredMessages(stored, transcript);
    const lastStored = placed.at(-1)?.transcriptIndex;
    const appended =
      input.append && lastStored !== undefined ? transcript.slice(lastStored + 1) : [];
    const messages = [
      ...placed,
      ...appended.map((message, offset) => ({
        message,
        transcriptIndex: lastStored! + 1 + offset,
      })),
    ];

    const providerThread = records.providerThreads.find(
      (candidate) => candidate.id === records.thread.activeProviderThreadId,
    );
    const lastPlaced = Math.max(
      -1,
      ...messages.flatMap((entry) =>
        entry.transcriptIndex === undefined ? [] : [entry.transcriptIndex],
      ),
    );
    // Where T3 Code's first turn starts in the transcript, which its own
    // turns are appended to: found by the prompt's uuid or text, or the end
    // when no prompt follows the imported ones.
    const firstNativeRun = nativeRuns[0];
    const firstNativePrompt = {
      uuid: promptUuidOf(firstNativeRun),
      text: records.messages.find((message) => message.id === firstNativeRun?.userMessageId)?.text,
    };
    const laterPrompts = transcript.flatMap((message, index) =>
      index > lastPlaced && message.role === "user" && message.nativeUserMessageId !== undefined
        ? [index]
        : [],
    );
    const endBefore =
      firstNativeRun === undefined || laterPrompts.length === 0
        ? transcript.length
        : laterPrompts.find(
            (index) =>
              (firstNativePrompt.uuid !== undefined &&
                transcript[index]!.nativeUserMessageId === firstNativePrompt.uuid) ||
              transcript[index]!.text === firstNativePrompt.text,
          );
    const recordsTurns =
      providerThread !== undefined &&
      thread.source === "claudeAgent" &&
      providerThread.nativeThreadRef?.nativeId === thread.providerSessionId &&
      (nativeRuns.length === 0 || importedRuns.length === 0);
    const turns =
      recordsTurns && endBefore !== undefined ? placedTurns(messages, transcript, endBefore) : [];

    const existing = {
      messageRunIds: new Map(records.messages.map((message) => [message.id, message.runId])),
      providerTurns: records.providerTurns,
    };
    const events =
      providerThread === undefined
        ? appended.flatMap((message, offset) =>
            messageEvents({ threadId, index: placed.length + offset, message }),
          )
        : conversationEvents({
            threadId,
            thread: { ...thread, messages: messages.map((entry) => entry.message) },
            turns,
            // Imported turns of a thread that already ran turns are numbered after them.
            runOrdinalBase: Math.max(0, ...nativeRuns.map((run) => run.ordinal)),
            providerTurnOrdinalBase:
              nativeRuns.length === 0
                ? 0
                : Math.max(
                    0,
                    ...records.providerTurns
                      .filter((turn) => turn.providerThreadId === providerThread.id)
                      .map((turn) => turn.ordinal),
                  ),
            providerThreadId: providerThread.id,
            existing,
          });
    if (
      providerThread !== undefined &&
      nativeRuns.length === 0 &&
      turns.length > 0 &&
      providerThread.lastRunOrdinal !== turns.length
    ) {
      events.push({
        id: EventId.make(
          `${IMPORT_EVENT_PREFIX}:provider-thread:${providerThread.id}:runs:${turns.length}`,
        ),
        type: "provider-thread.updated",
        threadId,
        driver: providerThread.driver,
        providerInstanceId: providerThread.providerInstanceId,
        occurredAt: dateTime(thread.updatedAt),
        payload: { ...providerThread, firstRunOrdinal: 1, lastRunOrdinal: turns.length },
      });
    }
    if (events.length > 0) yield* eventSink.write({ events });

    const skipped =
      recordsTurns && endBefore === undefined
        ? "the transcript does not show where T3 Code's first turn starts"
        : recordsTurns && turns.length === 0
          ? "none of its prompts is placed in the transcript"
          : undefined;
    if ((unplaced.length > 0 || skipped !== undefined) && (events.length > 0 || !input.append)) {
      yield* Effect.logWarning("Some messages of an imported chat get no rewind point", {
        threadId,
        ...(skipped === undefined ? {} : { skipped }),
        unplaced,
      });
    }
    return {
      appended: appended.length,
      recordedTurns: events.some((event) => event.type === "run.created"),
    };
  });

  /**
   * Append the messages a transcript gained since `threadId` was imported from
   * it. `thread` is a read of the whole transcript (`allMessages`). Only a
   * thread that never ran a turn in T3 Code is refreshed: once it has, T3
   * Code's copy of the session is the one being continued. Returns the number
   * of messages appended.
   */
  const appendImportedMessages = Effect.fn("appendImportedAgentMessagesV2")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: AgentSessionScanner.AgentSessionThread;
    readonly source: AgentSessionImportSource;
  }) {
    const { threadId } = input;
    const existing = yield* untouchedImport(threadId);
    if (Option.isNone(existing)) return 0;
    const { appended } = yield* syncImport({
      threadId,
      thread: input.thread,
      records: existing.value,
      append: true,
    });
    yield* runtimes.recordImportedTranscript({ threadId, source: input.source });
    return appended;
  });

  /**
   * Gives a Claude chat imported before imports kept transcript uuids a run
   * per prompt, read from the whole transcript it was imported from. Only the
   * messages it already shows are touched, each placed by its content, so
   * repeating it is a no-op. A chat that ran turns in T3 Code since keeps
   * them as they are. Callers hold the thread's command lock: the new runs
   * take the next ordinals, as a turn being started would. Returns whether
   * the chat was healed.
   */
  const healImportedThread = Effect.fn("healImportedAgentThreadV2")(function* (input: {
    readonly threadId: ThreadId;
    readonly source: AgentSessionImportSource;
  }) {
    const { threadId, source } = input;
    return yield* Effect.gen(function* () {
      const existing = yield* importRecords(threadId);
      if (
        Option.isNone(existing) ||
        existing.value.runs.some(
          (run) => isImportedTranscriptRun(run) || !SETTLED_RUN_STATUSES.has(run.status),
        )
      ) {
        return false;
      }
      const read = yield* scanner.readThread({
        filePath: source.filePath,
        source: "claudeAgent",
        providerInstanceId: source.providerInstanceId,
        allMessages: true,
      });
      if (Option.isNone(read)) return false;
      const { recordedTurns } = yield* syncImport({
        threadId,
        thread: read.value.thread,
        records: existing.value,
        append: false,
      });
      return recordedTurns;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not record rewind points for an imported chat", {
          threadId,
          cause,
        }).pipe(Effect.as(false)),
      ),
    );
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
    healImportedThread,
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
