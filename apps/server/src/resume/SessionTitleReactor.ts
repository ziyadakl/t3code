/**
 * SessionTitleReactor — writes a deliberate t3 thread rename through to the
 * underlying Claude CLI session's custom title, so resuming that session from
 * the terminal shows the new name.
 *
 * The Claude Agent SDK's `renameSession` appends a custom-title entry to the
 * session's JSONL file (exactly what the CLI `/rename` does). We call it ONLY
 * for deliberate USER renames of Claude-backed threads:
 *
 *  - `thread.meta-updated` with a non-empty `title`, and
 *  - `titleSource === "user"` — the load-bearing gate. Auto-titles are tagged
 *    `"auto"` and worktree-branch renames carry no title, so both are skipped.
 *
 * The write-through is forked and failures are logged, never propagated: a
 * CLI-file write must never block the in-app rename or tear down the event
 * stream. dir resolution likewise degrades to `undefined` (the SDK then
 * searches all project dirs and matches by session-id) rather than blocking.
 *
 * `renameSession` is injected (not imported into the hot path) so the decision
 * logic is unit-testable with a recording fake; the Live layer wires the real
 * SDK call.
 *
 * @module SessionTitleReactor
 */
import { renameSession as sdkRenameSession } from "@anthropic-ai/claude-agent-sdk";
import { ProviderDriverKind, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";

const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");

class SessionRenameError extends Data.TaggedError("SessionRenameError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

/**
 * The write-through, shaped like the SDK's `renameSession`. Injected so the
 * decision logic is testable with a recording fake. `dir`, when omitted, lets
 * the SDK search all project dirs and match by session-id UUID.
 */
export interface RenameSessionWrite {
  (
    sessionId: string,
    title: string,
    options?: { readonly dir?: string },
  ): Effect.Effect<void, SessionRenameError>;
}

/** Live write-through: wraps the real SDK `renameSession` Promise. */
export const liveRenameSessionWrite: RenameSessionWrite = (sessionId, title, options) =>
  Effect.tryPromise({
    try: () => sdkRenameSession(sessionId, title, options),
    catch: (cause) => new SessionRenameError({ detail: "renameSession failed", cause }),
  });

/**
 * Extract the Claude session id from a persisted resume cursor. Minimal, local
 * parser (the canonical reader `readClaudeResumeState` is private): an object
 * with a string `resume` (fallback to string `sessionId`). Anything else means
 * the thread never ran an SDK session — nothing to rename, so skip.
 */
export const claudeSessionIdFromCursor = (resumeCursor: unknown): string | undefined => {
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }
  const cursor = resumeCursor as { resume?: unknown; sessionId?: unknown };
  if (typeof cursor.resume === "string" && cursor.resume.length > 0) {
    return cursor.resume;
  }
  if (typeof cursor.sessionId === "string" && cursor.sessionId.length > 0) {
    return cursor.sessionId;
  }
  return undefined;
};

/**
 * The slice of a `thread.meta-updated` payload the reactor needs. Declared
 * narrow so the reactor can pass `event.payload` directly (structural
 * supertype) without coupling to every ThreadMetaUpdatedPayload field.
 */
export interface MetaUpdatedForRename {
  readonly threadId: ThreadId;
  readonly title?: string | undefined;
  readonly titleSource?: "user" | "auto" | undefined;
}

/**
 * Resolve the workspace root (dir) for a thread's rename, best-effort. Any
 * miss — no thread shell, no project shell, or a projection read error —
 * degrades to `undefined` so the rename is never blocked on dir resolution.
 */
const resolveThreadDir = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const thread = yield* snapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!thread) {
      return undefined;
    }
    const project = yield* snapshotQuery
      .getProjectShellById(thread.projectId)
      .pipe(Effect.map(Option.getOrUndefined));
    return project?.workspaceRoot;
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));

/**
 * React to a `thread.meta-updated`: write the new title through to the Claude
 * session, but ONLY for deliberate user renames of Claude-backed threads that
 * have actually run a session. Resolves dir best-effort, then FORKS the
 * write-through so a slow/failing CLI write never blocks the stream.
 *
 * `renameSession` is injected so this is unit-testable without the real SDK.
 */
export const handleMetaUpdated = (
  payload: MetaUpdatedForRename,
  deps: { readonly renameSession: RenameSessionWrite },
) =>
  Effect.gen(function* () {
    const title = payload.title;
    if (!title || payload.titleSource !== "user") {
      return;
    }

    const directory = yield* ProviderSessionDirectory;
    const binding = yield* directory
      .getBinding(payload.threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!binding || binding.provider !== CLAUDE_DRIVER_KIND) {
      return;
    }

    const sessionId = claudeSessionIdFromCursor(binding.resumeCursor);
    if (!sessionId) {
      return;
    }

    const dir = yield* resolveThreadDir(payload.threadId);

    yield* Effect.forkScoped(
      deps
        .renameSession(sessionId, title, dir ? { dir } : undefined)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("session title write-through failed", {
              threadId: payload.threadId,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
    );
  });

export interface SessionTitleReactorShape {
  /**
   * Start the reactor. Must run in a scope so the subscription fiber is
   * finalized on shutdown. Mirrors ResumeSeedReactor's forkScoped pattern.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class SessionTitleReactor extends Context.Service<
  SessionTitleReactor,
  SessionTitleReactorShape
>()("t3/resume/SessionTitleReactor") {}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  // Captured here so the forked stream effect does not leak service
  // requirements into `start`'s scope-only signature.
  const directory = yield* ProviderSessionDirectory;
  const snapshotQuery = yield* ProjectionSnapshotQuery;

  const start: SessionTitleReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.meta-updated") {
          return Effect.void;
        }
        const payload = event.payload;
        if (!payload.title || payload.titleSource !== "user") {
          return Effect.void;
        }
        return handleMetaUpdated(payload, { renameSession: liveRenameSessionWrite }).pipe(
          Effect.provideService(ProviderSessionDirectory, directory),
          Effect.provideService(ProjectionSnapshotQuery, snapshotQuery),
          Effect.catchCause((cause) =>
            Effect.logWarning("session title reactor failed", {
              threadId: payload.threadId,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      }),
    );
  });

  return { start } satisfies SessionTitleReactorShape;
});

export const SessionTitleReactorLive = Layer.effect(SessionTitleReactor, make);
