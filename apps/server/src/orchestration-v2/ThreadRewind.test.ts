import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { previousConversationRun } from "./ThreadRewindTargets.ts";
import { userFacingDispatchErrorMessage } from "./UserFacingErrors.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-sonnet-4-6" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
// No effect worker: runs stay unstarted, so Stop ends them without a provider.
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-rewind" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const messageId = (threadId: ThreadId, text: string) =>
  MessageId.make(`message:${threadId}:${text}`);

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:thread-rewind"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const send = (threadId: ThreadId, text: string, type: "start_immediately" | "queue_after_active") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: messageId(threadId, text),
      text,
      attachments: [],
      dispatchMode: { type },
      createdBy: "user",
      creationSource: "web",
    });
  });

it.effect("refuses to rewind while a message waits in the queue, even a held one", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:rewind-held-queue");
    yield* createThread(threadId);
    yield* send(threadId, "first", "start_immediately");
    yield* send(threadId, "queued", "queue_after_active");
    const [first] = (yield* orchestrator.getThreadProjection(threadId)).runs;
    // Stop ends the turn and holds the queued message.
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("stop-rewind-held-queue"),
      threadId,
      runId: first!.id,
      holdQueue: true,
    });
    const stopped = yield* orchestrator.getThreadProjection(threadId);
    assert.deepEqual(
      stopped.runs.map((run) => `${run.status}${run.queueHeld === true ? ":held" : ""}`),
      ["interrupted", "queued:held"],
    );
    const before = yield* orchestrator.getThreadEventSequence(threadId);

    const refusal = yield* orchestrator
      .dispatch({
        type: "thread.rewind",
        commandId: CommandId.make("rewind-held-queue"),
        threadId,
        messageId: messageId(threadId, "first"),
        choice: "conversation",
      })
      .pipe(Effect.flip, Effect.map(userFacingDispatchErrorMessage));

    assert.equal(refusal, "Send or remove your queued messages before rewinding.");
    assert.equal(yield* orchestrator.getThreadEventSequence(threadId), before);
  }).pipe(Effect.provide(layerTest)),
);

/**
 * Sends `text`, then settles its run as the provider would have: `completed`
 * with a Claude turn on `providerThreadId`, or `cancelled` with none (the
 * user stopped it before Claude answered).
 */
const sendAndSettle = (
  threadId: ThreadId,
  text: string,
  outcome:
    | { readonly status: "completed"; readonly turnOn?: string }
    | { readonly status: "cancelled" },
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    yield* send(threadId, text, "start_immediately");
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const run = projection.runs.find(
      (candidate) => candidate.userMessageId === messageId(threadId, text),
    )!;
    const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId)!;
    const now = yield* DateTime.now;
    const turn =
      outcome.status === "completed"
        ? [
            {
              id: EventId.make(`event:${run.id}:turn`),
              type: "provider-turn.updated" as const,
              threadId,
              runId: run.id,
              occurredAt: now,
              payload: {
                id: ProviderTurnId.make(`provider-turn:${run.id}`),
                providerThreadId: ProviderThreadId.make(outcome.turnOn ?? attempt.providerThreadId),
                nodeId: attempt.rootNodeId,
                runAttemptId: attempt.id,
                nativeTurnRef: null,
                ordinal: run.ordinal,
                status: "completed" as const,
                startedAt: now,
                completedAt: now,
              },
            },
          ]
        : [];
    yield* eventSink.write({
      commandId: CommandId.make(`settle:${run.id}`),
      events: [
        ...turn,
        {
          id: EventId.make(`event:${run.id}:done`),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: outcome.status, completedAt: now },
        },
      ],
    });
  });

it.effect(
  "rewinds past cancelled turns Claude never answered, back to the last answered turn",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:rewind-skips-unanswered");
      yield* createThread(threadId);
      yield* sendAndSettle(threadId, "answered", { status: "completed" });
      yield* sendAndSettle(threadId, "stopped-1", { status: "cancelled" });
      yield* sendAndSettle(threadId, "stopped-2", { status: "cancelled" });
      yield* sendAndSettle(threadId, "last", { status: "completed" });

      const commandId = CommandId.make("rewind-skips-unanswered");
      yield* orchestrator.dispatch({
        type: "thread.rewind",
        commandId,
        threadId,
        messageId: messageId(threadId, "last"),
        choice: "conversation",
      });

      const projection = yield* orchestrator.getThreadProjection(threadId);
      const last = projection.runs.find((run) => run.userMessageId === messageId(threadId, "last"));
      // The rewind was accepted: the thread records it as the current one.
      assert.equal(projection.thread.rollbackRequestId, commandId);
      // The rewind resumes at the answered run, not at a cancelled one.
      assert.equal(
        previousConversationRun(projection, last!)?.userMessageId,
        messageId(threadId, "answered"),
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("still refuses when the turn before was answered in a different Claude session", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:rewind-other-session");
    yield* createThread(threadId);
    yield* sendAndSettle(threadId, "answered-elsewhere", {
      status: "completed",
      turnOn: "provider-thread:another-session",
    });
    yield* sendAndSettle(threadId, "last", { status: "completed" });

    const refusal = yield* orchestrator
      .dispatch({
        type: "thread.rewind",
        commandId: CommandId.make("rewind-other-session"),
        threadId,
        messageId: messageId(threadId, "last"),
        choice: "conversation",
      })
      .pipe(Effect.flip, Effect.map(userFacingDispatchErrorMessage));

    assert.equal(
      refusal,
      "Cannot rewind to this message: the turn before it is not part of the current Claude session.",
    );
  }).pipe(Effect.provide(layerTest)),
);
