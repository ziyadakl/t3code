import {
  CheckpointId,
  CheckpointScopeId,
  latestProviderTurnForAttempt,
  type OrchestrationV2DomainEvent,
  type ProviderSessionId,
  ProviderThreadId,
  type RunId,
  ThreadId,
  type ThreadRewindChoice,
  threadRewindRestores,
  VcsProcessExitError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import type * as ServerConfig from "../config.ts";
import type * as ServerSettings from "../serverSettings.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import {
  isCheckpointRestoreIsolated,
  SHARED_WORKSPACE_RESTORE_MESSAGE,
} from "./CheckpointRestoreSafety.ts";
import { CheckpointRestoreError, CheckpointServiceV2 } from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { type ProjectionRecords, ProjectionStoreV2 } from "./ProjectionStore.ts";
import { GIT_INDEX_LOCKED_DETAIL } from "../vcs/VcsProcess.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import {
  openProviderThreadSession,
  skippedFilesMessage,
  ThreadCodeRewindServiceV2,
} from "./ThreadCodeRewindService.ts";
import {
  compareConversationOrder,
  previousConversationRun,
  threadStartResumeAt,
} from "./ThreadRewindTargets.ts";

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
const isVcsProcessExitError = Schema.is(VcsProcessExitError);
const isCheckpointRestoreError = Schema.is(CheckpointRestoreError);

/**
 * The message clients see when a rollback fails. Only a held Git index lock
 * gets its own explanation; other reasons carry internal ids or raw Git
 * output, so they fall back to the generic message.
 */
export function rollbackFailureClientMessage(error: CheckpointRollbackExecutionError): string {
  const restoreCause = isCheckpointRestoreError(error.cause) ? error.cause.cause : undefined;
  return isVcsProcessExitError(restoreCause) && restoreCause.detail === GIT_INDEX_LOCKED_DETAIL
    ? GIT_INDEX_LOCKED_DETAIL
    : ROLLBACK_FAILED_MESSAGE;
}

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
  | GitWorkflowService.GitWorkflowService
  | EventSinkV2
  | IdAllocator.IdAllocatorV2
  | ProjectionStoreV2
  | ProviderSessionManagerV2
  | RuntimePolicyV2
  | FileSystem.FileSystem
  | Path.Path
  | ProjectStore.ProjectStoreV2
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService
  | ThreadCommandExecutor.ThreadCommandExecutor
  | ThreadCodeRewindServiceV2
> = Layer.effect(
  CheckpointRollbackServiceV2,
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointServiceV2;
    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
    const eventSink = yield* EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const projections = yield* ProjectionStoreV2;
    const sessions = yield* ProviderSessionManagerV2;
    const runtimePolicy = yield* RuntimePolicyV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const path = yield* Path.Path;
    const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const isManagedWorktreePath = yield* makeIsManagedWorktreePath;
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
     * What a rollback reads about its thread. `execute` fills it from the narrow
     * checkpoint rollback query, so unrelated rows cannot fail the read; a rewind
     * to a message fills it from the whole projection.
     */
    type RollbackSource = {
      readonly thread: RollbackProjection["thread"];
      readonly providerSessions: RollbackProjection["providerSessions"];
      readonly providerTurns: RollbackProjection["providerTurns"];
      readonly targetAttempt:
        | Pick<RollbackProjection["attempts"][number], "id" | "providerTurnId">
        | undefined;
      readonly rolledBackAttemptIds: ReadonlySet<RollbackProjection["attempts"][number]["id"]>;
      readonly runsToRollback: RollbackProjection["runs"];
      readonly rootNodes: RollbackProjection["nodes"];
      readonly staleCheckpoints: RollbackProjection["checkpoints"];
      readonly scopes: RollbackProjection["checkpointScopes"];
    };

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
        targetAttempt: projection.attempts.find(
          (attempt) => attempt.id === targetRun?.activeAttemptId,
        ),
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

    /**
     * Rewinds the provider conversation to just after run `targetOrdinal` (0: the thread
     * start). Later runs leave it and their ready checkpoints go stale: in `scopeId` for a
     * checkpoint rollback, in every scope for a rewind to a message. `restoreFiles` runs
     * once the provider rewound.
     */
    const rollbackConversation = Effect.fn("orchestrationV2.checkpointRollback.conversation")(
      function* (input: {
        readonly threadId: ThreadId;
        readonly source: RollbackSource;
        readonly providerThread: RollbackProjection["providerThreads"][number];
        readonly providerSessionId: ProviderSessionId;
        readonly targetOrdinal: number;
        readonly checkpointId: CheckpointId | undefined;
        readonly restoreFiles: Effect.Effect<void, unknown>;
      }) {
        const { source, providerThread, targetOrdinal } = input;
        const { runsToRollback } = source;
        const failure = (reason: CheckpointRollbackExecutionError["reason"]) =>
          new CheckpointRollbackExecutionError({
            reason,
            threadId: input.threadId,
            providerThreadId: providerThread.id,
            ...(input.checkpointId === undefined ? {} : { checkpointId: input.checkpointId }),
          });
        const { session } = yield* openProviderThreadSession(
          { sessions, runtimePolicy },
          {
            projection: { thread: source.thread, providerSessions: source.providerSessions },
            providerThread,
            providerSessionId: input.providerSessionId,
          },
        );

        const providerThreadTurns = source.providerTurns.filter(
          (turn) =>
            turn.providerThreadId === providerThread.id &&
            (turn.runAttemptId === null || !source.rolledBackAttemptIds.has(turn.runAttemptId)),
        );
        const nativeResumeAt = threadStartResumeAt(source.providerTurns, providerThread.id);
        const rollbackTarget: ProviderAdapter.ProviderAdapterV2RollbackTarget =
          targetOrdinal === 0
            ? {
                type: "thread_start",
                ...(input.checkpointId === undefined ? {} : { checkpointId: input.checkpointId }),
                appRunOrdinal: 0,
                ...(nativeResumeAt === undefined ? {} : { nativeResumeAt }),
              }
            : yield* Effect.gen(function* () {
                // A goal run can span several native turns; roll back to its last.
                const targetTurn =
                  latestProviderTurnForAttempt(source.providerTurns, source.targetAttempt?.id) ??
                  source.providerTurns.find(
                    (turn) => turn.id === source.targetAttempt?.providerTurnId,
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
        const { staleCheckpoints } = source;
        for (const scope of source.scopes) {
          const staleRefs = staleCheckpoints.filter((candidate) => candidate.scopeId === scope.id);
          if (staleRefs.length > 0) {
            yield* checkpoints.deleteStaleRefs({ scope, checkpoints: staleRefs });
          }
        }

        // Thread commands write full provider thread rows under this lock. Without
        // it, a message sent during the rollback can plan against the old native
        // session and commit after this, undoing the provider's fork.
        yield* threadCommands.withLock(
          input.threadId,
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const makeEvent = <Event extends OrchestrationV2DomainEvent>(
              event: Omit<Event, "id">,
            ) =>
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
              const rootNode = source.rootNodes.find(
                (candidate) => candidate.id === run.rootNodeId,
              );
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
          }),
        );
      },
    );

    const execute = Effect.fn("orchestrationV2.checkpointRollback.execute")(function* (input: {
      readonly threadId: ThreadId;
      readonly providerThreadId: ProviderThreadId;
      readonly checkpointId: CheckpointId;
      readonly scopeId: CheckpointScopeId;
      readonly restoreFiles?: boolean;
    }) {
      const context = yield* projections.getCheckpointRollbackContext(input.threadId, input);
      const { providerThread, checkpoint, scope, targetAttempt } = context;
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
        providerThread.id !== context.thread.activeProviderThreadId ||
        providerThread.providerInstanceId !== context.thread.modelSelection.instanceId
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "active-provider-changed",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }

      const targetOrdinal = checkpoint.appRunOrdinal ?? 0;
      // Checked before any worktree is recreated or file restored.
      if (targetOrdinal !== 0) {
        const targetTurn =
          latestProviderTurnForAttempt(context.providerTurns, targetAttempt?.id) ??
          context.providerTurns.find((turn) => turn.id === targetAttempt?.providerTurnId);
        if (targetTurn === undefined || targetTurn.providerThreadId !== providerThread.id) {
          return yield* new CheckpointRollbackExecutionError({
            reason: "provider-turn-unavailable",
            threadId: input.threadId,
            providerThreadId: input.providerThreadId,
            checkpointId: input.checkpointId,
          });
        }
      }

      const { worktreePath, branch } = context.thread;
      // Recreated only where the server would have made it, as turn start does.
      if (
        worktreePath != null &&
        branch != null &&
        !(yield* fileSystem.exists(worktreePath)) &&
        (yield* isManagedWorktreePath(worktreePath))
      ) {
        const project = yield* projects.get(context.thread.projectId);
        if (Option.isSome(project)) {
          yield* gitWorkflow.pruneWorktrees({ cwd: project.value.workspaceRoot });
          yield* gitWorkflow.createWorktree({
            cwd: project.value.workspaceRoot,
            refName: branch,
            path: worktreePath,
          });
        }
      }

      if (
        input.restoreFiles !== false &&
        !(yield* isCheckpointRestoreIsolated(context.thread, scope, {
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
        source: {
          thread: context.thread,
          providerSessions: context.providerSession === undefined ? [] : [context.providerSession],
          providerTurns: context.providerTurns,
          targetAttempt,
          rolledBackAttemptIds: new Set(context.rolledBackAttemptIds),
          runsToRollback: context.runsToRollback,
          rootNodes: context.rootNodes,
          staleCheckpoints: context.staleCheckpoints,
          scopes: [scope],
        },
        providerThread,
        providerSessionId: providerThread.providerSessionId,
        targetOrdinal,
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
      const rewindConversation = rollbackConversation({
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

    // Storage cleanup removes worktrees under the same lease.
    const withThreadWorkspaceLease = Effect.fn(
      "CheckpointRollbackService.withThreadWorkspaceLease",
    )(function* <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) {
      const thread = yield* projections.getThread(threadId);
      return yield* thread.worktreePath == null
        ? effect
        : withWorkspaceLease(path.resolve(thread.worktreePath), effect);
    });

    return CheckpointRollbackServiceV2.of({
      execute: Effect.fn("CheckpointRollbackServiceV2.execute")(
        (input: Parameters<CheckpointRollbackServiceV2["Service"]["execute"]>[0]) =>
          withThreadWorkspaceLease(input.threadId, execute(input)),
        (effect, input) => effect.pipe(Effect.mapError(asExecutionError(input))),
      ),
      rewind: Effect.fn("CheckpointRollbackServiceV2.rewind")(
        (input: Parameters<CheckpointRollbackServiceV2["Service"]["rewind"]>[0]) =>
          withThreadWorkspaceLease(input.threadId, rewind(input)),
        (effect, input) => effect.pipe(Effect.mapError(asExecutionError(input))),
      ),
    });
  }),
);
