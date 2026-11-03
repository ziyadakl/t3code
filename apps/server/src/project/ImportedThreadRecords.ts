import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  type MessageId,
  type NodeId,
  ProviderDriverKind,
  type ProviderThreadId,
  type RunId,
  type ThreadId,
  TurnItemId,
  type AgentSessionImportSource,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { isImportedTranscriptRun } from "../orchestration-v2/ThreadRewindTargets.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import type { AgentSessionThread, AgentSessionThreadMessage } from "./AgentSessionScanner.ts";
import {
  type ImportedTurn,
  importedMessageId,
  placedTurns,
  placeStoredMessages,
  SETTLED_RUN_STATUSES,
} from "./ImportedClaudeTranscript.ts";

export const IMPORT_EVENT_PREFIX = "agent-session-import:v2";

export function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: AgentSessionThreadMessage;
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

/**
 * What an imported thread's records are made of: the messages and, for a Claude chat, the run
 * per prompt that holds the uuids a rewind needs. The importer writes new threads with
 * `conversationEvents`; `syncImport` and `healImportedThread` bring an existing one up to its
 * transcript, for the desktop mirror, the resume picker and the rewind heal alike.
 */
export const make = Effect.gen(function* () {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;

  /**
   * Events that bring an imported thread up to `thread`: the messages it does not hold yet
   * and, for a Claude transcript, one completed run per prompt whose provider turn holds the
   * prompt's uuid and the uuid its turn ended at. Empty once the thread is current.
   */
  const conversationEvents = (input: {
    readonly threadId: ThreadId;
    readonly thread: AgentSessionThread;
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
   * Brings an import up to `thread`, a read of its whole transcript: places its messages,
   * appends later ones when `append`, and records a run per placed prompt before any run T3
   * Code ran. Returns the messages appended and whether runs were recorded.
   */
  const syncImport = Effect.fn("syncAgentImportV2")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: AgentSessionThread;
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
   * Gives a Claude chat imported before imports kept transcript uuids a run per prompt, read
   * from its whole transcript. Only messages it already shows are touched, so repeating is a
   * no-op, and a chat that ran turns in T3 Code keeps them. Callers hold the thread's command
   * lock. Returns whether the chat was healed.
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

  return { conversationEvents, importRecords, syncImport, healImportedThread };
});
