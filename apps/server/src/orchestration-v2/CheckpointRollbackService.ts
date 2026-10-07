import {
  CheckpointId,
  CheckpointScopeId,
  latestProviderTurnForAttempt,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type ProviderSessionId,
  ProviderThreadId,
  type RunId,
  ThreadId,
  type ThreadRewindChoice,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  isCheckpointRestoreIsolated,
  SHARED_WORKSPACE_RESTORE_MESSAGE,
} from "./CheckpointRestoreSafety.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { IdAllocatorV2 } from "./IdAllocator.ts";
import { type ProjectionRecords, ProjectionStoreV2 } from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type { ProviderAdapterV2RollbackTarget } from "./ProviderAdapter.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";
import {
  openProviderThreadSession,
  skippedFilesMessage,
  ThreadCodeRewindServiceV2,
} from "./ThreadCodeRewindService.ts";
import { compareConversationOrder, previousConversationRun } from "./ThreadRewindTargets.ts";

export const ROLLBACK_FAILED_MESSAGE =
  "The provider could not roll back this conversation. Try again; if it keeps failing, check the provider and server logs.";

export class CheckpointRollbackExecutionError extends Schema.TaggedError<CheckpointRollbackExecutionError>()(
  "CheckpointRollbackExecutionError",
  {
    reason: Schema.Literals([
      "rollback-target-invalid",
      "active-provider-changed",
      "provider-turn-unavailable",
      "unexpected-failure",
      "shared-workspace",
    ]),
    threadId: ThreadId,
    providerThreadId: ProviderThreadId,
    /** Absent for a rewind to a message. */
    checkpointId: Schema.optional(CheckpointId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const target = this.checkpointId ?? "before the rewound message";
    switch (this.reason) {
      case "rollback-target-invalid":
        return `Rollback target ${target} for provider thread ${this.providerThreadId} on thread ${this.threadId} is incomplete or invalid.`;
      case "active-provider-changed":
        return `Active provider changed before rollback target ${target} could execute on thread ${this.threadId}.`;
      case "provider-turn-unavailable":
        return `Provider turn for rollback target ${target} is unavailable on provider thread ${this.providerThreadId}.`;
      case "shared-workspace":
        return SHARED_WORKSPACE_RESTORE_MESSAGE;
      case "unexpected-failure":
        return ROLLBACK_FAILED_MESSAGE;
    }
  }
}

const isCheckpointRollbackExecutionError = Schema.is(CheckpointRollbackExecutionError);

/**
 * How a rewind ended. `refused`: the provider declined (for example Claude kept
 * no file snapshot) and nothing changed; retrying cannot help.
 */
export type ThreadRewindOutcome =
  | { readonly type: "completed"; readonly notice?: string }
  | { readonly type: "refused"; readonly message: string };

export interface CheckpointRollbackServiceV2Shape {
  readonly execute: (input: {
    readonly threadId: ThreadId;
    readonly providerThreadId: ProviderThreadId;
    readonly checkpointId: CheckpointId;
    readonly scopeId: CheckpointScopeId;
    readonly restoreFiles?: boolean;
  }) => Effect.Effect<void, CheckpointRollbackExecutionError>;
  /** Carries out a `thread.rewind` choice for the user message that started `runId`. */
  readonly rewind: (input: {
    readonly threadId: ThreadId;
    readonly providerThreadId: ProviderThreadId;
    readonly runId: RunId;
    readonly choice: ThreadRewindChoice;
  }) => Effect.Effect<ThreadRewindOutcome, CheckpointRollbackExecutionError>;
}

export class CheckpointRollbackServiceV2 extends Context.Service<
  CheckpointRollbackServiceV2,
  CheckpointRollbackServiceV2Shape
>()("t3/orchestration-v2/CheckpointRollbackService/CheckpointRollbackServiceV2") {}

export const layer: Layer.Layer<
  CheckpointRollbackServiceV2,
  never,
  | CheckpointServiceV2
  | EventSinkV2
  | IdAllocatorV2
  | ProjectionStoreV2
  | ProviderSessionManagerV2
  | RuntimePolicyV2
  | FileSystem.FileSystem
  | Path.Path
  | ProjectStore.ProjectStoreV2
  | ThreadCodeRewindServiceV2
> = Layer.effect(
  CheckpointRollbackServiceV2,
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointServiceV2;
    const eventSink = yield* EventSinkV2;
    const ids = yield* IdAllocatorV2;
    const projections = yield* ProjectionStoreV2;
    const sessions = yield* ProviderSessionManagerV2;
    const runtimePolicy = yield* RuntimePolicyV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const path = yield* Path.Path;
    const codeRewind = yield* ThreadCodeRewindServiceV2;

    const projectionFields = [
      "providerThreads",
      "providerSessions",
      "checkpoints",
      "checkpointScopes",
      "runs",
      "attempts",
      "nodes",
      "providerTurns",
    ] as const;
    type RollbackProjection = ProjectionRecords<(typeof projectionFields)[number]>;

    /**
     * Rewinds the provider conversation to just after run `targetOrdinal` (0:
     * the thread start). Later runs leave the conversation and their
     * checkpoints go stale. `restoreFiles` runs once the provider rewound.
     */
    const rollbackConversation = Effect.fn("orchestrationV2.checkpointRollback.conversation")(
      function* (input: {
        readonly threadId: ThreadId;
        readonly projection: RollbackProjection;
        readonly providerThread: RollbackProjection["providerThreads"][number];
        readonly providerSessionId: ProviderSessionId;
        readonly targetOrdinal: number;
        readonly checkpointId: CheckpointId | undefined;
        readonly restoreFiles: Effect.Effect<void, unknown>;
      }) {
        const { projection, providerThread, targetOrdinal } = input;
        // Imported runs can carry higher ordinals than turns that came after
        // them, so "after the target" follows conversation order.
        const targetRun = projection.runs.find((run) => run.ordinal === targetOrdinal);
        const isAfterTarget = (ordinal: number) => {
          const run = projection.runs.find((candidate) => candidate.ordinal === ordinal);
          return targetRun === undefined || run === undefined
            ? ordinal > targetOrdinal
            : compareConversationOrder(run, targetRun) > 0;
        };
        const failure = (reason: CheckpointRollbackExecutionError["reason"]) =>
          new CheckpointRollbackExecutionError({
            reason,
            threadId: input.threadId,
            providerThreadId: providerThread.id,
            ...(input.checkpointId === undefined ? {} : { checkpointId: input.checkpointId }),
          });
        const { session } = yield* openProviderThreadSession(
          { sessions, runtimePolicy },
          { projection, providerThread, providerSessionId: input.providerSessionId },
        );

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
        const rolledBackAttemptIds = new Set(
          projection.attempts
            .filter((attempt) => rolledBackRunIds.has(attempt.runId))
            .map((attempt) => attempt.id),
        );
        const providerThreadTurns = projection.providerTurns.filter(
          (turn) =>
            turn.providerThreadId === providerThread.id &&
            (turn.runAttemptId === null || !rolledBackAttemptIds.has(turn.runAttemptId)),
        );
        const rollbackTarget: ProviderAdapterV2RollbackTarget =
          targetOrdinal === 0
            ? {
                type: "thread_start",
                ...(input.checkpointId === undefined ? {} : { checkpointId: input.checkpointId }),
                appRunOrdinal: 0,
              }
            : yield* Effect.gen(function* () {
                const targetRun = projection.runs.find((run) => run.ordinal === targetOrdinal);
                const targetAttempt = projection.attempts.find(
                  (attempt) => attempt.id === targetRun?.activeAttemptId,
                );
                // A goal run can span several native turns; roll back to its last.
                const targetTurn =
                  latestProviderTurnForAttempt(projection.providerTurns, targetAttempt?.id) ??
                  projection.providerTurns.find(
                    (turn) => turn.id === targetAttempt?.providerTurnId,
                  );
                if (targetTurn === undefined || targetTurn.providerThreadId !== providerThread.id) {
                  return yield* failure("provider-turn-unavailable");
                }
                return {
                  type: "provider_turn" as const,
                  ...(input.checkpointId === undefined ? {} : { checkpointId: input.checkpointId }),
                  appRunOrdinal: targetOrdinal,
                  providerTurn: targetTurn,
                };
              });

        const snapshot =
          runsToRollback.length === 0
            ? { providerThread }
            : yield* session.rollbackThread({
                providerThread,
                target: rollbackTarget,
                providerThreadTurns,
              });
        yield* input.restoreFiles;
        const staleCheckpoints = projection.checkpoints.filter(
          (candidate) =>
            candidate.appRunOrdinal !== null &&
            isAfterTarget(candidate.appRunOrdinal) &&
            candidate.status !== "stale",
        );
        for (const scope of projection.checkpointScopes) {
          const staleRefs = staleCheckpoints.filter(
            (candidate) => candidate.scopeId === scope.id && candidate.status === "ready",
          );
          if (staleRefs.length > 0) {
            yield* checkpoints.deleteStaleRefs({ scope, checkpoints: staleRefs });
          }
        }

        const now = yield* DateTime.now;
        const makeEvent = <Event extends OrchestrationV2DomainEvent>(event: Omit<Event, "id">) =>
          Effect.map(
            ids.allocate.event({ threadId: event.threadId }),
            (id) =>
              ({
                ...event,
                id,
              }) as Event,
          );
        const events: Array<OrchestrationV2DomainEvent> = [];
        events.push(
          yield* makeEvent({
            type: "provider-thread.updated",
            threadId: input.threadId,
            driver: providerThread.driver,
            providerInstanceId: providerThread.providerInstanceId,
            occurredAt: now,
            payload: {
              ...snapshot.providerThread,
              lastRunOrdinal: targetOrdinal === 0 ? null : targetOrdinal,
              updatedAt: now,
            },
          }),
        );
        for (const staleCheckpoint of staleCheckpoints) {
          events.push(
            yield* makeEvent({
              type: "checkpoint.captured",
              threadId: input.threadId,
              ...(staleCheckpoint.runId === null ? {} : { runId: staleCheckpoint.runId }),
              nodeId: staleCheckpoint.nodeId,
              providerInstanceId: providerThread.providerInstanceId,
              occurredAt: now,
              payload: { ...staleCheckpoint, status: "stale" },
            }),
          );
        }
        for (const run of runsToRollback) {
          const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
          events.push(
            yield* makeEvent({
              type: "run.updated",
              threadId: input.threadId,
              runId: run.id,
              ...(rootNode === undefined ? {} : { nodeId: rootNode.id }),
              providerInstanceId: run.providerInstanceId,
              occurredAt: now,
              payload: { ...run, status: "rolled_back", completedAt: now },
            }),
          );
          if (rootNode !== undefined) {
            events.push(
              yield* makeEvent({
                type: "node.updated",
                threadId: input.threadId,
                runId: run.id,
                nodeId: rootNode.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: { ...rootNode, status: "rolled_back", completedAt: now },
              }),
            );
          }
        }
        yield* eventSink.write({ events });
      },
    );

    const execute = Effect.fn("orchestrationV2.checkpointRollback.execute")(function* (input: {
      readonly threadId: ThreadId;
      readonly providerThreadId: ProviderThreadId;
      readonly checkpointId: CheckpointId;
      readonly scopeId: CheckpointScopeId;
      readonly restoreFiles?: boolean;
    }) {
      const projection = yield* projections.getThreadRecords(input.threadId, projectionFields);
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === input.providerThreadId,
      );
      const checkpoint = projection.checkpoints.find(
        (candidate) => candidate.id === input.checkpointId,
      );
      const scope = projection.checkpointScopes.find((candidate) => candidate.id === input.scopeId);
      if (
        providerThread === undefined ||
        providerThread.providerSessionId === null ||
        checkpoint === undefined ||
        scope === undefined ||
        checkpoint.scopeId !== scope.id ||
        checkpoint.status !== "ready"
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "rollback-target-invalid",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
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
          checkpointId: input.checkpointId,
        });
      }

      if (
        input.restoreFiles !== false &&
        !(yield* isCheckpointRestoreIsolated(projection.thread, scope, {
          fileSystem,
          projections,
          projects,
          path,
        }))
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "shared-workspace",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }

      yield* rollbackConversation({
        threadId: input.threadId,
        projection,
        providerThread,
        providerSessionId: providerThread.providerSessionId,
        targetOrdinal: checkpoint.appRunOrdinal ?? 0,
        checkpointId: checkpoint.id,
        restoreFiles:
          input.restoreFiles === false
            ? Effect.void
            : Effect.suspend(() => checkpoints.restore({ scope, checkpoint })),
      });
    });

    const rewind = Effect.fn("orchestrationV2.checkpointRollback.rewind")(function* (input: {
      readonly threadId: ThreadId;
      readonly providerThreadId: ProviderThreadId;
      readonly runId: RunId;
      readonly choice: ThreadRewindChoice;
    }) {
      const projection = yield* projections.getThreadRecords(input.threadId, projectionFields);
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === input.providerThreadId,
      );
      const run = projection.runs.find((candidate) => candidate.id === input.runId);
      if (
        providerThread === undefined ||
        providerThread.providerSessionId === null ||
        run === undefined ||
        run.status === "rolled_back" ||
        (input.choice !== "conversation" &&
          input.choice !== "code" &&
          input.choice !== "code-and-conversation")
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
      // Files go back first, from the live session that knows the later
      // turns; a refusal leaves the conversation as it was.
      let notice: string | null = null;
      if (input.choice !== "conversation") {
        const restored = yield* codeRewind.restore({ threadId: input.threadId, runId: run.id });
        if (!restored.restored) {
          return { type: "refused" as const, message: restored.reason };
        }
        notice = skippedFilesMessage(restored.skippedLinks);
      }
      if (input.choice !== "code") {
        yield* rollbackConversation({
          threadId: input.threadId,
          projection,
          providerThread,
          providerSessionId: providerThread.providerSessionId,
          targetOrdinal: previousConversationRun(projection.runs, run)?.ordinal ?? 0,
          checkpointId: undefined,
          restoreFiles: Effect.void,
        });
      }
      return notice === null
        ? { type: "completed" as const }
        : { type: "completed" as const, notice };
    });

    const asExecutionError =
      (input: {
        readonly threadId: ThreadId;
        readonly providerThreadId: ProviderThreadId;
        readonly checkpointId?: CheckpointId;
      }) =>
      (cause: unknown) =>
        isCheckpointRollbackExecutionError(cause)
          ? cause
          : new CheckpointRollbackExecutionError({
              reason: "unexpected-failure",
              threadId: input.threadId,
              providerThreadId: input.providerThreadId,
              ...(input.checkpointId === undefined ? {} : { checkpointId: input.checkpointId }),
              cause,
            });

    return CheckpointRollbackServiceV2.of({
      execute: (input) => execute(input).pipe(Effect.mapError(asExecutionError(input))),
      rewind: (input) => rewind(input).pipe(Effect.mapError(asExecutionError(input))),
    });
  }),
);
