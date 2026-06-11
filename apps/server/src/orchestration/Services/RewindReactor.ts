/**
 * RewindReactor - Conversation-rewind reaction service interface (ADR-0002).
 *
 * Owns the background worker that reacts to the two non-destructive
 * conversation-rewind orchestration events:
 *
 * - `thread.conversation-rewind-requested`: resolve the pre-prompt anchor uuid,
 *   set the provider-session cursor marker (`resumeSessionAt` + `rewindPending`),
 *   and dispatch the bridge command so the projection marks forward rows
 *   abandoned (never deletes). NON-DESTRUCTIVE: the working tree is untouched.
 * - `thread.files-restore-requested`: restore the working tree to a turn via
 *   `CheckpointStore.restoreCheckpoint` ONLY — the decoupled file half of the
 *   old bundled revert, with no message/turn deletion.
 *
 * Distinct from `CheckpointReactor`, which still owns the destructive
 * `thread.checkpoint-revert-requested` → `thread.reverted` path (backward-compat).
 *
 * @module RewindReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * RewindReactorShape - Service API for the conversation-rewind reactor lifecycle.
 */
export interface RewindReactorShape {
  /**
   * Start the rewind reactor.
   *
   * The returned effect must be run in a scope so the worker fiber is finalized
   * on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * RewindReactor - Service tag for conversation-rewind reactor workers.
 */
export class RewindReactor extends Context.Service<RewindReactor, RewindReactorShape>()(
  "t3/orchestration/Services/RewindReactor",
) {}
