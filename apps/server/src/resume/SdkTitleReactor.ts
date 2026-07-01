/**
 * SdkTitleReactor — gives a freshly-started Claude-backed thread a concise title
 * by reading the title the Claude Agent SDK already generates for the session
 * (`getSessionInfo().summary`) — the same title the `claude` CLI shows. For
 * Claude threads this replaces a separate title-generation subprocess (which,
 * when `textGenerationModelSelection` resolves to an unavailable provider, falls
 * back to a `claude -p` call that can hang for minutes); non-Claude threads keep
 * the generic generation path in ProviderCommandReactor.
 *
 * Trigger: the reliable `thread.turn-diff-completed` domain event. (The runtime
 * `turn.completed` event is a shared PubSub subscription that isn't reliably
 * delivered to a single reactor — see CheckpointReactor's note — so we react to
 * the domain event instead.) On the first such event for a thread whose title is
 * still the auto seed, we resolve the Claude session id from the provider
 * binding and poll `getSessionInfo` until the SDK's model-generated summary is
 * ready (it can lag a few seconds past turn completion), then dispatch
 * `thread.meta.update { titleSource: "auto" }`.
 *
 * "Still the auto seed" is decided against the RAW `titleSeed` the client sends
 * on `thread.turn-start-requested` (the same signal ProviderCommandReactor
 * trusts), captured per-thread here — NOT reconstructed from the stored first
 * message. The client titles a new thread from the raw prompt while storing a
 * TRANSFORMED message (ultrathink prefix, a terminal-context block, an image
 * bootstrap prompt), so reconstructing the seed from the stored text would
 * mismatch the title and silently skip titling for those shapes. We therefore
 * also observe `thread.turn-start-requested` to capture each thread's raw seed,
 * falling back to the reconstructed seed only when none was captured (e.g. a
 * resumed thread the reactor never saw start).
 *
 * The SDK read and the rename dispatch are injected so the decision logic is
 * unit-testable with recording fakes (mirrors SessionTitleReactor).
 *
 * @module SdkTitleReactor
 */
import { getSessionInfo as sdkGetSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { CommandId, type ThreadId } from "@t3tools/contracts";
import { truncate } from "@t3tools/shared/String";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { sanitizeThreadTitle } from "../textGeneration/TextGenerationUtils.ts";
import { claudeSessionIdFromCursor } from "./SessionTitleReactor.ts";
import { canReplaceThreadTitle, DEFAULT_THREAD_TITLE, defersTitleToSdk } from "./threadTitleRules.ts";

/** How many times to poll getSessionInfo for a ready summary, and the gap. */
const DEFAULT_MAX_POLL_ATTEMPTS = 6;
const DEFAULT_POLL_DELAY_MS = 2500;

class SdkTitleReadError extends Data.TaggedError("SdkTitleReadError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

/** The minimal slice of `SDKSessionInfo` the reactor reads. */
export interface SdkSessionTitleInfo {
  readonly summary: string;
  readonly firstPrompt?: string | undefined;
}

/**
 * Read a session's SDK title info, shaped like `getSessionInfo`. Injected so the
 * decision logic is testable without the real SDK. Resolves `undefined` when the
 * session file isn't found / has no extractable summary.
 */
export interface ReadSessionTitle {
  (
    sessionId: string,
    options?: { readonly dir?: string },
  ): Effect.Effect<SdkSessionTitleInfo | undefined, SdkTitleReadError>;
}

/** Live read: wraps the real SDK `getSessionInfo` Promise. */
export const liveReadSessionTitle: ReadSessionTitle = (sessionId, options) =>
  Effect.tryPromise({
    try: () => sdkGetSessionInfo(sessionId, options),
    catch: (cause) => new SdkTitleReadError({ detail: "getSessionInfo failed", cause }),
  }).pipe(
    Effect.map((info) =>
      info ? { summary: info.summary, firstPrompt: info.firstPrompt } : undefined,
    ),
  );

/** Dispatch the rename, injected so the decision logic records instead of dispatching. */
export interface DispatchRename {
  (threadId: ThreadId, title: string): Effect.Effect<void>;
}

/** Tunables + injected effects the decision logic depends on. */
export interface SdkTitleDeps {
  readonly readSessionTitle: ReadSessionTitle;
  readonly dispatchRename: DispatchRename;
  /** Threads with a poll in flight or already titled — guards against duplicate polls. */
  readonly handled: Set<string>;
  /**
   * Per-thread raw `titleSeed` captured from `thread.turn-start-requested` — the
   * exact value the client titled the thread with. Used to gate replacement so a
   * transformed stored first message (ultrathink/terminal/image) doesn't cause a
   * false mismatch. Absent entry → fall back to `firstUserTitleSeed`.
   */
  readonly titleSeeds: Map<string, string>;
  readonly maxAttempts?: number;
  readonly delayMillis?: number;
}

/** The auto title seed = truncated first user message, matching the client. */
export const firstUserTitleSeed = (
  messages: ReadonlyArray<{ readonly role: string; readonly text: string }>,
): string | undefined => {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) {
    return undefined;
  }
  const seed = truncate(firstUser.text);
  return seed.length > 0 ? seed : undefined;
};

/**
 * Capture a thread's raw client `titleSeed` — but ONLY the first time the thread
 * is seen. The web client sends a `titleSeed` on EVERY `thread.turn-start-requested`
 * (not just the first), yet a later turn's text must never overwrite the seed the
 * thread was originally titled with: a title poll forked from turn 1 can run for
 * ~15s and gates on this seed, so clobbering it with turn-2 text would make the
 * gate mismatch the current title and abandon auto-titling permanently. No-op when
 * the seed is absent or one was already captured — mirroring the module docstring
 * ("capture each thread's raw seed ... only when none was captured").
 */
export const captureTitleSeed = (
  threadId: string,
  seed: string | undefined,
  titleSeeds: Map<string, string>,
): void => {
  if (seed !== undefined && !titleSeeds.has(threadId)) {
    titleSeeds.set(threadId, seed);
  }
};

/**
 * The seed to gate title replacement against: the raw client `titleSeed`
 * captured for the thread when present (matches the title the client actually
 * set), else the reconstructed truncated-first-message seed (legacy fallback for
 * threads the reactor never saw start, e.g. resumes).
 */
export const effectiveTitleSeed = (
  threadId: ThreadId,
  messages: ReadonlyArray<{ readonly role: string; readonly text: string }>,
  deps: SdkTitleDeps,
): string | undefined => deps.titleSeeds.get(threadId) ?? firstUserTitleSeed(messages);

/**
 * Choose the title to apply from a session-info read, or null when it isn't a
 * usable, ready, distinct title:
 *  - no info / empty summary → null
 *  - summary still equals firstPrompt → the AI summary hasn't been generated yet
 *    (the SDK falls back to firstPrompt), so it's not ready → null
 *  - sanitizes to the placeholder, or equals the current title → null (no-op)
 */
export const pickSdkTitle = (
  info: SdkSessionTitleInfo | undefined,
  currentTitle: string,
): string | null => {
  if (!info || info.summary.trim().length === 0) {
    return null;
  }
  if (info.firstPrompt !== undefined && info.summary.trim() === info.firstPrompt.trim()) {
    return null;
  }
  const title = sanitizeThreadTitle(info.summary);
  if (title === DEFAULT_THREAD_TITLE || title === currentTitle.trim()) {
    return null;
  }
  return title;
};

/**
 * Poll getSessionInfo until the SDK summary is ready, re-checking each attempt
 * that the thread title is still replaceable (so a mid-poll user rename wins).
 * Returns the title to apply, or null if none became ready / the title is no
 * longer replaceable.
 */
export const resolveRenameTitle = (input: {
  readonly threadId: ThreadId;
  readonly sessionId: string;
  readonly dir: string | undefined;
  readonly deps: SdkTitleDeps;
}) =>
  Effect.gen(function* () {
    const { threadId, sessionId, dir, deps } = input;
    const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
    const delayMillis = deps.delayMillis ?? DEFAULT_POLL_DELAY_MS;
    const snapshotQuery = yield* ProjectionSnapshotQuery;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0 && delayMillis > 0) {
        yield* Effect.sleep(Duration.millis(delayMillis));
      }

      const thread = yield* snapshotQuery
        .getThreadDetailById(threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (!thread) {
        return null;
      }
      if (!canReplaceThreadTitle(thread.title, effectiveTitleSeed(threadId, thread.messages, deps))) {
        // User renamed (or a title already stuck) — stop, don't clobber.
        return null;
      }

      const info = yield* deps
        .readSessionTitle(sessionId, dir ? { dir } : undefined)
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      const title = pickSdkTitle(info, thread.title);
      if (title) {
        return title;
      }
    }
    return null;
  });

/**
 * React to a `thread.turn-diff-completed`: for a Claude-backed thread whose
 * title is still the auto seed, resolve the session id and FORK a poll that
 * applies the SDK's generated title. Gating runs inline; the (slow) poll +
 * dispatch are forked so the event stream is never blocked.
 */
export const handleTurnDiffCompleted = (threadId: ThreadId, deps: SdkTitleDeps) =>
  Effect.gen(function* () {
    if (deps.handled.has(threadId)) {
      return;
    }

    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const thread = yield* snapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!thread) {
      return;
    }
    if (!canReplaceThreadTitle(thread.title, effectiveTitleSeed(threadId, thread.messages, deps))) {
      return;
    }

    const directory = yield* ProviderSessionDirectory;
    const binding = yield* directory
      .getBinding(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!binding || !defersTitleToSdk(binding.provider)) {
      // Not an SDK-titleable thread (no binding / non-Claude provider): its
      // captured seed will never be consumed, so drop it now. Together with
      // capture-when-absent this bounds `titleSeeds` to in-flight threads
      // instead of accumulating one entry per thread for the process lifetime.
      // (Transient Claude give-ups below — title not ready, user-rename
      // mismatch — deliberately KEEP the seed so a later turn can retry.)
      deps.titleSeeds.delete(threadId);
      return;
    }
    const sessionId = claudeSessionIdFromCursor(binding.resumeCursor);
    if (!sessionId) {
      return;
    }

    const project = yield* snapshotQuery
      .getProjectShellById(thread.projectId)
      .pipe(
        Effect.map(Option.getOrUndefined),
        Effect.catch(() => Effect.succeed(undefined)),
      );
    const dir = project?.workspaceRoot;

    // Claim the thread so a later turn-diff-completed doesn't start a second poll.
    deps.handled.add(threadId);
    yield* Effect.forkScoped(
      resolveRenameTitle({ threadId, sessionId, dir, deps }).pipe(
        Effect.flatMap((title) =>
          title
            ? // Title applied — drop the captured seed (the claim in `handled` stays).
              deps
                .dispatchRename(threadId, title)
                .pipe(Effect.tap(() => Effect.sync(() => deps.titleSeeds.delete(threadId))))
            : // Nothing applied — release the claim so a later turn can retry.
              Effect.sync(() => deps.handled.delete(threadId)),
        ),
        Effect.catchCause((cause) => {
          deps.handled.delete(threadId);
          return Effect.logWarning("sdk title reactor poll failed", {
            threadId,
            cause: Cause.pretty(cause),
          });
        }),
      ),
    );
  });

export interface SdkTitleReactorShape {
  /** Start the reactor; must run in a scope so the subscription fiber is finalized. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class SdkTitleReactor extends Context.Service<SdkTitleReactor, SdkTitleReactorShape>()(
  "t3/resume/SdkTitleReactor",
) {}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  // Captured so the forked stream effect doesn't leak service requirements into
  // start's scope-only signature (mirrors SessionTitleReactor).
  const directory = yield* ProviderSessionDirectory;
  const snapshotQuery = yield* ProjectionSnapshotQuery;

  const dispatchRename: DispatchRename = (threadId, title) =>
    Effect.gen(function* () {
      const commandId = CommandId.make(`server:sdk-title:${yield* crypto.randomUUIDv4}`);
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId,
        threadId,
        title,
        titleSource: "auto",
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("sdk title reactor rename dispatch failed", {
          threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const handled = new Set<string>();
  const titleSeeds = new Map<string, string>();
  const deps: SdkTitleDeps = {
    readSessionTitle: liveReadSessionTitle,
    dispatchRename,
    handled,
    titleSeeds,
  };

  const start: SdkTitleReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        // Capture the raw client title seed up front so the diff-completed gate
        // matches the title the client actually set (which differs from the
        // stored, transformed first message for ultrathink/terminal/image).
        // Capture only the FIRST turn's seed: the client resends a titleSeed on
        // every turn, and a later turn must not clobber the seed an in-flight
        // poll is gating on (see captureTitleSeed).
        if (event.type === "thread.turn-start-requested") {
          captureTitleSeed(event.payload.threadId, event.payload.titleSeed, titleSeeds);
          return Effect.void;
        }
        if (event.type !== "thread.turn-diff-completed") {
          return Effect.void;
        }
        const threadId = event.payload.threadId;
        return handleTurnDiffCompleted(threadId, deps).pipe(
          Effect.provideService(ProviderSessionDirectory, directory),
          Effect.provideService(ProjectionSnapshotQuery, snapshotQuery),
          Effect.catchCause((cause) =>
            Effect.logWarning("sdk title reactor failed", {
              threadId,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      }),
    );
  });

  return { start } satisfies SdkTitleReactorShape;
});

export const SdkTitleReactorLive = Layer.effect(SdkTitleReactor, make);
