/**
 * Carries out a `thread.rewind`: restores code, rewinds the conversation, and
 * reports how it ended. The conversation step is the checkpoint rollback's own
 * `rollbackConversation`, so a fix to rollback reaches rewind.
 */
import {
  CommandId,
  type CheckpointScopeId,
  type ProviderThreadId,
  type RunId,
  type ThreadId,
  type ThreadRewindChoice,
  threadRewindRestores,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import {
  asExecutionError,
  CheckpointRollbackExecutionError,
  CheckpointRollbackServiceV2,
  ROLLBACK_FAILED_MESSAGE,
  rollbackFailureClientMessage,
  rollbackProjectionFields,
  type RollbackProjection,
  type RollbackSource,
} from "./CheckpointRollbackService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import type { ThreadManagementService } from "./ThreadManagementService.ts";
import * as ThreadCodeRewindService from "./ThreadCodeRewindService.ts";
import { skippedFilesMessage, ThreadCodeRewindServiceV2 } from "./ThreadCodeRewindService.ts";
import { compareConversationOrder, previousConversationRun } from "./ThreadRewindTargets.ts";
import type { ProviderThreadRewindRequest } from "./ThreadRewindTargets.ts";

const ALREADY_REWOUND_MESSAGE = "This message was already rewound.";

const CODE_ONLY_RESTORED_MESSAGE =
  "Your code was restored, but the conversation could not be rewound. Choose Restore conversation to try again.";

/**
 * How a rewind ended. `refused`: the provider declined (for example Claude kept
 * no file snapshot) and nothing changed; retrying cannot help.
 */
export type ThreadRewindOutcome =
  | { readonly type: "completed"; readonly notice?: string }
  | { readonly type: "refused"; readonly message: string };

export interface ThreadRewindServiceV2Shape {
  /** Carries out a `thread.rewind` choice for the user message that started `runId`. */
  readonly rewind: (input: {
    readonly threadId: ThreadId;
    readonly providerThreadId: ProviderThreadId;
    readonly runId: RunId;
    readonly choice: ThreadRewindChoice;
  }) => Effect.Effect<ThreadRewindOutcome, CheckpointRollbackExecutionError>;
}

export class ThreadRewindServiceV2 extends Context.Service<
  ThreadRewindServiceV2,
  ThreadRewindServiceV2Shape
>()("t3/orchestration-v2/ThreadRewindService/ThreadRewindServiceV2") {}

/**
 * The rollback source for a rewind to a message, read from the whole
 * projection (a checkpoint rollback reads a narrow query instead).
 */
const rollbackSourceFromProjection = (
  projection: RollbackProjection,
  target: { readonly ordinal: number; readonly scopeId: CheckpointScopeId | undefined },
): RollbackSource => {
  // Imported runs can carry higher ordinals than turns that came after
  // them, so "after the target" follows conversation order.
  const targetRun = projection.runs.find((run) => run.ordinal === target.ordinal);
  const isAfterTarget = (ordinal: number) => {
    const run = projection.runs.find((candidate) => candidate.ordinal === ordinal);
    return targetRun === undefined || run === undefined
      ? ordinal > target.ordinal
      : compareConversationOrder(run, targetRun) > 0;
  };
  // Stopped and failed runs after the target leave the provider
  // conversation too, so they must not stay visible.
  const runsToRollback = projection.runs.filter(
    (run) =>
      isAfterTarget(run.ordinal) &&
      (run.status === "completed" ||
        run.status === "interrupted" ||
        run.status === "failed" ||
        run.status === "cancelled"),
  );
  // Rolled-back turns stay in the audit history, but no longer exist in
  // the provider conversation and must not be counted by a later rewind.
  const rolledBackRunIds = new Set(
    projection.runs.filter((run) => run.status === "rolled_back").map((run) => run.id),
  );
  return {
    thread: projection.thread,
    providerSessions: projection.providerSessions,
    providerTurns: projection.providerTurns,
    targetAttempt: projection.attempts.find((attempt) => attempt.id === targetRun?.activeAttemptId),
    rolledBackAttemptIds: new Set(
      projection.attempts
        .filter((attempt) => rolledBackRunIds.has(attempt.runId))
        .map((attempt) => attempt.id),
    ),
    runsToRollback,
    rootNodes: projection.nodes,
    staleCheckpoints: projection.checkpoints.filter(
      (candidate) =>
        (target.scopeId === undefined || candidate.scopeId === target.scopeId) &&
        candidate.appRunOrdinal !== null &&
        isAfterTarget(candidate.appRunOrdinal) &&
        candidate.status === "ready",
    ),
    scopes: projection.checkpointScopes,
  };
};

export const layer: Layer.Layer<
  ThreadRewindServiceV2,
  never,
  CheckpointRollbackServiceV2 | ProjectionStoreV2 | ThreadCodeRewindServiceV2 | Path.Path
> = Layer.effect(
  ThreadRewindServiceV2,
  Effect.gen(function* () {
    const checkpointRollback = yield* CheckpointRollbackServiceV2;
    const projections = yield* ProjectionStoreV2;
    const codeRewind = yield* ThreadCodeRewindServiceV2;
    const path = yield* Path.Path;

    const rewind = Effect.fn("orchestrationV2.checkpointRollback.rewind")(function* (input: {
      readonly threadId: ThreadId;
      readonly providerThreadId: ProviderThreadId;
      readonly runId: RunId;
      readonly choice: ThreadRewindChoice;
    }) {
      const projection = yield* projections.getThreadRecords(
        input.threadId,
        rollbackProjectionFields,
      );
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === input.providerThreadId,
      );
      const run = projection.runs.find((candidate) => candidate.id === input.runId);
      const restores = threadRewindRestores(input.choice);
      if (
        providerThread === undefined ||
        providerThread.providerSessionId === null ||
        run === undefined ||
        restores === null
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "rollback-target-invalid",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
        });
      }
      if (
        providerThread.id !== projection.thread.activeProviderThreadId ||
        providerThread.providerInstanceId !== projection.thread.modelSelection.instanceId
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "active-provider-changed",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
        });
      }
      // Two clients can rewind the same message at once; the later rewind
      // finds it done and changes nothing.
      if (run.status === "rolled_back") {
        return { type: "completed" as const, notice: ALREADY_REWOUND_MESSAGE };
      }
      const targetOrdinal = previousConversationRun(projection.runs, run)?.ordinal ?? 0;
      const rewindConversation = checkpointRollback.rollbackConversation({
        threadId: input.threadId,
        source: rollbackSourceFromProjection(projection, {
          ordinal: targetOrdinal,
          scopeId: undefined,
        }),
        providerThread,
        providerSessionId: providerThread.providerSessionId,
        targetOrdinal,
        checkpointId: undefined,
        restoreFiles: Effect.void,
      });
      if (!restores.code) {
        yield* rewindConversation;
        return { type: "completed" as const };
      }
      // Files go back first, from the live session that knows the later
      // turns; a refusal leaves the conversation as it was.
      const restored = yield* codeRewind.restore({ threadId: input.threadId, runId: run.id });
      if (!restored.restored) {
        return { type: "refused" as const, message: restored.reason };
      }
      const notice = skippedFilesMessage(restored.skippedLinks);
      const completed =
        notice === null ? { type: "completed" as const } : { type: "completed" as const, notice };
      if (!restores.conversation) return completed;
      // Retrying the whole rewind would find the files already back and
      // refuse, so a failure here ends the rewind and says what changed.
      return yield* rewindConversation.pipe(
        Effect.as(completed),
        Effect.catch((cause) =>
          Effect.logWarning("Rewind restored code but not the conversation", { cause }).pipe(
            Effect.as({ type: "refused" as const, message: CODE_ONLY_RESTORED_MESSAGE }),
          ),
        ),
      );
    });

    // Storage cleanup removes worktrees under the same lease.
    const withThreadWorkspaceLease = Effect.fn(
      "CheckpointRollbackService.withThreadWorkspaceLease",
    )(function* <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) {
      const thread = yield* projections.getThread(threadId);
      return yield* thread.worktreePath == null
        ? effect
        : withWorkspaceLease(path.resolve(thread.worktreePath), effect);
    });

    return ThreadRewindServiceV2.of({
      rewind: Effect.fn("CheckpointRollbackServiceV2.rewind")(
        (input: Parameters<ThreadRewindServiceV2["Service"]["rewind"]>[0]) =>
          withThreadWorkspaceLease(input.threadId, rewind(input)),
        (effect, input) => effect.pipe(Effect.mapError(asExecutionError(input))),
      ),
    });
  }),
);

/**
 * Both rewind services. Needs the orchestrator (the code restore reads and
 * drives its live session) and the checkpoint rollback service.
 */
export const layerWithCodeRewind = layer.pipe(Layer.provideMerge(ThreadCodeRewindService.layer));

/**
 * `layerWithCodeRewind` with the projection store provided. `runtimeLayer.ts` passes
 * the layers it already builds, so each service is built once.
 */
export const layerProvided = <E, R>(
  dependencies: Layer.Layer<
    Exclude<Layer.Services<typeof layerWithCodeRewind>, ProjectionStoreV2 | Path.Path>,
    E,
    R
  >,
) => layerWithCodeRewind.pipe(Layer.provide(Layer.mergeAll(ProjectionStore.layer, dependencies)));

/**
 * Runs a `provider-thread.rewind` outbox effect. Waiting clients learn how the
 * rewind ended: a code restore changes no run, so only this tells them. The last
 * failed attempt tells them it failed, instead of leaving them to time out;
 * they get a fixed message, and the worker logs the full cause for each attempt.
 */
export const runRewindEffect = (
  effect: {
    readonly id: string;
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
  },
  request: typeof ProviderThreadRewindRequest.Type,
  deps: {
    readonly rewind: ThreadRewindServiceV2["Service"];
    readonly threads: Pick<ThreadManagementService["Service"], "dispatch">;
    readonly willRetry: boolean;
  },
) => {
  const { rewind, threads, willRetry } = deps;
  return rewind
    .rewind({
      threadId: effect.threadId,
      providerThreadId: request.providerThreadId,
      runId: request.runId,
      choice: request.choice,
    })
    .pipe(
      Effect.flatMap((outcome) =>
        threads
          .dispatch(
            outcome.type === "refused"
              ? {
                  type: "checkpoint.rollback.fail",
                  commandId: CommandId.make(`${effect.commandId}:rollback-failed`),
                  threadId: effect.threadId,
                  requestId: effect.commandId,
                  message: outcome.message,
                }
              : {
                  type: "checkpoint.rollback.complete",
                  commandId: CommandId.make(`${effect.commandId}:rollback-completed`),
                  threadId: effect.threadId,
                  requestId: effect.commandId,
                  ...(outcome.notice === undefined ? {} : { notice: outcome.notice }),
                },
          )
          .pipe(
            Effect.catchCause((recordCause) =>
              Effect.logWarning("Failed to record rewind outcome", {
                effectId: effect.id,
                cause: recordCause,
              }),
            ),
          ),
      ),
      Effect.tapCause((cause) =>
        willRetry || Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : threads
              .dispatch({
                type: "checkpoint.rollback.fail",
                commandId: CommandId.make(`${effect.commandId}:rollback-failed`),
                threadId: effect.threadId,
                requestId: effect.commandId,
                message: Option.match(Cause.findErrorOption(cause), {
                  onNone: () => ROLLBACK_FAILED_MESSAGE,
                  onSome: rollbackFailureClientMessage,
                }),
              })
              .pipe(
                Effect.catchCause((recordCause) =>
                  Effect.logWarning("Failed to record rollback failure", {
                    effectId: effect.id,
                    cause: recordCause,
                  }),
                ),
              ),
      ),
    );
};
