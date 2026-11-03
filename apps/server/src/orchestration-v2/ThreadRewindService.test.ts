import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import { ThreadCodeRewindServiceV2 } from "./ThreadCodeRewindService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ThreadRewindService from "./ThreadRewindService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const unrelatedProject = Option.some({
  workspaceRoot: "/nonexistent/t3-rollback-project",
} as never);

/** A Claude thread whose second message is rewound; `secondRun` is its run's status. */
const rewindLayer = (input: {
  readonly secondRun: "completed" | "rolled_back";
  readonly rollbackThread: () => Effect.Effect<unknown, string>;
  readonly calls: Array<string>;
}) => {
  const threadId = ThreadId.make("rewind-thread");
  const providerThreadId = ProviderThreadId.make("rewind-thread-provider");
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const providerThread = {
    id: providerThreadId,
    providerSessionId: ProviderSessionId.make("rewind-thread-session"),
    providerInstanceId: instanceId,
  };
  const projection = {
    thread: {
      id: threadId,
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId, model: "claude-sonnet-4-6" },
    },
    providerThreads: [providerThread],
    providerSessions: [],
    providerTurns: [1, 2].map((ordinal) => ({
      id: `turn-${ordinal}`,
      providerThreadId,
      runAttemptId: `attempt-${ordinal}`,
      ordinal,
      status: "completed",
    })),
    nodes: [],
    attempts: [1, 2].map((ordinal) => ({ id: `attempt-${ordinal}`, runId: `run-${ordinal}` })),
    checkpoints: [],
    checkpointScopes: [],
    runs: [1, 2].map((ordinal) => ({
      id: `run-${ordinal}`,
      threadId,
      userMessageId: `message-${ordinal}`,
      ordinal,
      status: ordinal === 2 ? input.secondRun : "completed",
      rootNodeId: null,
      activeAttemptId: `attempt-${ordinal}`,
    })),
  } as unknown as OrchestrationV2ThreadProjection;
  const dependencies = Layer.mergeAll(
    NodeServices.layer,
    Layer.mock(ServerConfig.ServerConfig)({ worktreesDir: "/synthetic-worktrees" } as never),
    ServerSettings.layerTest(),
    Layer.mock(GitWorkflow.GitWorkflowService)({}),
    Layer.mock(ThreadCodeRewindServiceV2)({
      restore: () =>
        Effect.sync(() => {
          input.calls.push("code");
          return { restored: true as const, skippedLinks: 0 };
        }),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeed(unrelatedProject) }),
    Layer.mock(CheckpointService.CheckpointServiceV2)({}),
    Layer.mock(EventSink.EventSinkV2)({
      write: () =>
        Effect.sync(() => {
          input.calls.push("projection");
          return [];
        }),
    }),
    ThreadCommandExecutor.layer,
    IdAllocator.layer,
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThread: () => Effect.succeed(projection.thread),
      getProviderControlContext: () => Effect.succeed({ attempt: undefined } as never),
      getThreadRecords: () => Effect.succeed(projection),
    }),
    Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
      open: () =>
        Effect.succeed({
          rollbackThread: () => input.rollbackThread().pipe(Effect.as({ providerThread })),
        } as never),
    }),
    Layer.mock(RuntimePolicy.RuntimePolicyV2)({ resolve: () => Effect.succeed({} as never) }),
  );
  // The real conversation rollback, as the effect worker wires it.
  const layer = ThreadRewindService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        CheckpointRollbackService.layer.pipe(Layer.provide(dependencies)),
        dependencies,
      ),
    ),
  );
  return { layer, threadId, providerThreadId };
};

it.effect("a rewind of a message another rewind already undid completes, changing nothing", () => {
  const calls: Array<string> = [];
  const { layer, threadId, providerThreadId } = rewindLayer({
    secondRun: "rolled_back",
    rollbackThread: () => Effect.sync(() => calls.push("provider")),
    calls,
  });
  return Effect.gen(function* () {
    const service = yield* ThreadRewindService.ThreadRewindServiceV2;
    const outcome = yield* service.rewind({
      threadId,
      providerThreadId,
      runId: "run-2" as never,
      choice: "code-and-conversation",
    });

    assert.deepEqual(outcome, {
      type: "completed",
      notice: "This message was already rewound.",
    });
    assert.deepEqual(calls, []);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "restore code and conversation says the code was restored when the conversation could not be",
  () => {
    const calls: Array<string> = [];
    const { layer, threadId, providerThreadId } = rewindLayer({
      secondRun: "completed",
      rollbackThread: () => Effect.fail("Claude could not resume the session."),
      calls,
    });
    return Effect.gen(function* () {
      const service = yield* ThreadRewindService.ThreadRewindServiceV2;
      const outcome = yield* service.rewind({
        threadId,
        providerThreadId,
        runId: "run-2" as never,
        choice: "code-and-conversation",
      });

      assert.deepEqual(outcome, {
        type: "refused",
        message:
          "Your code was restored, but the conversation could not be rewound. Choose Restore conversation to try again.",
      });
      assert.deepEqual(calls, ["code"]);
    }).pipe(Effect.provide(layer));
  },
);
