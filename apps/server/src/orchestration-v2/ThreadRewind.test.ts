import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
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
} as ProviderAdapterV2Shape;
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
