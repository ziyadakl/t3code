import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadArchiveService from "./ThreadArchiveService.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed to archive threads"),
} as ProviderAdapterV2Shape;
const layerDatabase = SqlitePersistence.layerMemory;
const layerProjections = ProjectionStore.layer.pipe(Layer.provide(layerDatabase));
const layerOrchestration = ProviderReplayHarness.layerWithRegistry(
  { name: "thread-archive" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { databaseLayer: layerDatabase, runEffectWorker: false },
);
const layerTest = Layer.mergeAll(
  layerProjections,
  layerOrchestration,
  ThreadArchiveService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerProjections,
        layerOrchestration,
        EventStore.layer.pipe(Layer.provide(layerDatabase)),
        ServerSettings.layerTest().pipe(Layer.orDie),
        NodeCrypto.layer,
      ),
    ),
  ),
);

it.effect("archiving a parent archives its idle helpers, and unarchiving restores only those", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const service = yield* ThreadArchiveService.ThreadArchiveServiceV2;
      yield* service.start();

      const parent = ThreadId.make("thread:archive-parent");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-parent"),
        threadId: parent,
        projectId: ProjectId.make("project:archive"),
        title: "Parent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const parentThread = (yield* projections.getThreadProjection(parent)).thread;
      const now = yield* DateTime.now;
      const createHelper = (name: string) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(`thread:archive-${name}`);
          yield* sink.write({
            events: [
              {
                id: EventId.make(`event:create-${name}`),
                type: "thread.created",
                threadId,
                occurredAt: now,
                payload: {
                  ...parentThread,
                  id: threadId,
                  title: name,
                  lineage: {
                    parentThreadId: parent,
                    relationshipToParent: "subagent",
                    rootThreadId: parent,
                  },
                },
              },
            ],
          });
          return threadId;
        });
      const idle = yield* createHelper("idle");
      const running = yield* createHelper("running");
      const archivedAlone = yield* createHelper("archived-alone");
      const runId = RunId.make("run:archive-running");
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:run-running"),
            type: "run.created",
            threadId: running,
            occurredAt: now,
            payload: {
              id: runId,
              threadId: running,
              ordinal: 1,
              providerInstanceId: instanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: MessageId.make("message:archive-running"),
              rootNodeId: null,
              activeAttemptId: null,
              status: "running",
              requestedAt: now,
              startedAt: now,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
        ],
      });

      // Replays from the start, so it cannot miss an event committed before it subscribes.
      const awaitEvent = (threadId: ThreadId, eventType: "thread.archived" | "thread.unarchived") =>
        sink
          .stream({ threadId, eventType, afterSequence: 0 })
          .pipe(Stream.take(1), Stream.runDrain);
      const archivedAt = (threadId: ThreadId) =>
        projections
          .getThreadProjection(threadId)
          .pipe(Effect.map(({ thread }) => thread.archivedAt));

      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-alone"),
        threadId: archivedAlone,
      });
      yield* TestClock.adjust("1 minute");

      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-parent"),
        threadId: parent,
      });
      yield* awaitEvent(idle, "thread.archived");
      yield* service.drain;
      assert.notEqual(yield* archivedAt(idle), null);
      assert.equal(yield* archivedAt(running), null);

      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("unarchive-parent"),
        threadId: parent,
      });
      yield* awaitEvent(idle, "thread.unarchived");
      yield* service.drain;
      assert.equal(yield* archivedAt(idle), null);
      assert.notEqual(yield* archivedAt(archivedAlone), null);
    }).pipe(Effect.provide(layerTest)),
  ),
);
