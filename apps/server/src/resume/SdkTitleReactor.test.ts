import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../persistence/Layers/ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import {
  effectiveTitleSeed,
  firstUserTitleSeed,
  handleTurnDiffCompleted,
  pickSdkTitle,
  resolveRenameTitle,
  type DispatchRename,
  type ReadSessionTitle,
  type SdkSessionTitleInfo,
  type SdkTitleDeps,
} from "./SdkTitleReactor.ts";

const WORKSPACE_ROOT = "/workspace/demo";
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const CLAUDE_SESSION_ID = "00a5c392-f7f3-4e01-ad14-1bba7c69d789";
const INSTANCE_ID = ProviderInstanceId.make("claude-default");
const DEFAULT_TITLE = "New thread";

// ---------------------------------------------------------------------------
// Fakes / fixtures
// ---------------------------------------------------------------------------

// Records each dispatched rename so a test can assert it fired (and with what)
// or, crucially, that it did NOT fire. Mirrors SessionTitleReactor.test.
interface RecordedDispatch {
  readonly threadId: ThreadId;
  readonly title: string;
}
const makeRecorder = () => {
  const calls: Array<RecordedDispatch> = [];
  const dispatchRename: DispatchRename = (threadId, title) =>
    Effect.sync(() => {
      calls.push({ threadId, title });
    });
  return { calls, dispatchRename };
};

// An injected SDK read that yields a fixed sequence of info objects, sticking on
// the last entry once exhausted — lets a test model "not ready, then ready".
const readSeq = (infos: ReadonlyArray<SdkSessionTitleInfo | undefined>): ReadSessionTitle => {
  let i = 0;
  return () => Effect.succeed(infos[Math.min(i++, infos.length - 1)]);
};

// An injected SDK read that must never be invoked (gating short-circuited first).
const readShouldNotRun: ReadSessionTitle = () =>
  Effect.die("readSessionTitle was called but the reactor should have short-circuited");

// A minimal OrchestrationThread for the snapshot stub. The reactor only reads
// `title` and `messages` (+ `projectId` for dir resolution); the rest is cast
// away (mirrors the `as never` stub pattern in SessionTitleReactor.test).
const makeThread = (
  title: string,
  messages: ReadonlyArray<{ readonly role: string; readonly text: string }>,
): OrchestrationThread =>
  ({
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title,
    messages,
  }) as never;

const projectShellSome: Option.Option<OrchestrationProjectShell> = Option.some({
  id: PROJECT_ID,
  workspaceRoot: WORKSPACE_ROOT,
} as never);

// Stub of ProjectionSnapshotQuery: only the two methods the reactor touches
// (`getThreadDetailById`, `getProjectShellById`) resolve; every other method
// dies (never called here). `thread` is a function of the call index so a test
// can return a user-renamed title mid-poll. Mirrors the full-object stub in
// SessionTitleReactor.test / CheckpointDiffQuery.test.
const makeSnapshotService = (opts: {
  readonly thread: (call: number) => Option.Option<OrchestrationThread>;
  readonly project?: Option.Option<OrchestrationProjectShell>;
}): ProjectionSnapshotQuery["Service"] => {
  let detailCalls = 0;
  return {
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getArchivedProjectsSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.die("unused"),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
    getArchivedProjectByWorkspaceRoot: () => Effect.die("unused"),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadShellById: () => Effect.die("unused"),
    getThreadDetailById: () => Effect.sync(() => opts.thread(detailCalls++)),
    getProjectShellById: () => Effect.succeed(opts.project ?? Option.none()),
  };
};

// Let any forked poll+dispatch fiber run to completion before asserting.
const settle = Effect.gen(function* () {
  for (let i = 0; i < 5; i++) {
    yield* Effect.yieldNow;
  }
});

// ===========================================================================
// PURE: firstUserTitleSeed
// ===========================================================================

it("firstUserTitleSeed: returns the truncated first USER message text", () => {
  const longText = "a".repeat(60);
  const seed = firstUserTitleSeed([
    { role: "assistant", text: "preamble" },
    { role: "user", text: longText },
    { role: "user", text: "second user message" },
  ]);
  assert.equal(seed, `${"a".repeat(50)}...`);
});

it("firstUserTitleSeed: returns undefined when there is no user message", () => {
  assert.equal(firstUserTitleSeed([{ role: "assistant", text: "hi" }]), undefined);
  assert.equal(firstUserTitleSeed([]), undefined);
});

it("firstUserTitleSeed: returns undefined when the first user text is empty/whitespace", () => {
  assert.equal(firstUserTitleSeed([{ role: "user", text: "" }]), undefined);
  assert.equal(firstUserTitleSeed([{ role: "user", text: "   " }]), undefined);
});

// ===========================================================================
// PURE: effectiveTitleSeed (captured raw seed wins; falls back to reconstruction)
// ===========================================================================

const depsWithSeeds = (titleSeeds: Map<string, string>): SdkTitleDeps => ({
  readSessionTitle: readShouldNotRun,
  dispatchRename: makeRecorder().dispatchRename,
  handled: new Set(),
  titleSeeds,
});

it("effectiveTitleSeed: returns the captured raw client seed when present", () => {
  // Stored message is the TRANSFORMED text; the captured seed is the raw prompt.
  const deps = depsWithSeeds(new Map([[THREAD_ID, "Refactor the auth module"]]));
  const seed = effectiveTitleSeed(
    THREAD_ID,
    [{ role: "user", text: "Ultrathink:\nRefactor the auth module" }],
    deps,
  );
  assert.equal(seed, "Refactor the auth module");
});

it("effectiveTitleSeed: falls back to the reconstructed first-message seed when none captured", () => {
  const deps = depsWithSeeds(new Map());
  const seed = effectiveTitleSeed(THREAD_ID, [{ role: "user", text: "do the thing" }], deps);
  assert.equal(seed, "do the thing");
});

// ===========================================================================
// PURE: pickSdkTitle
// ===========================================================================

it("pickSdkTitle: undefined info -> null", () => {
  assert.equal(pickSdkTitle(undefined, DEFAULT_TITLE), null);
});

it("pickSdkTitle: empty/whitespace summary -> null", () => {
  assert.equal(pickSdkTitle({ summary: "" }, DEFAULT_TITLE), null);
  assert.equal(pickSdkTitle({ summary: "   " }, DEFAULT_TITLE), null);
});

it("pickSdkTitle: summary still equal to firstPrompt (not yet AI-generated) -> null", () => {
  assert.equal(
    pickSdkTitle({ summary: "Hello there", firstPrompt: "Hello there" }, DEFAULT_TITLE),
    null,
  );
  // Whitespace-insensitive equality.
  assert.equal(
    pickSdkTitle({ summary: "  Hello there  ", firstPrompt: "Hello there" }, DEFAULT_TITLE),
    null,
  );
});

it("pickSdkTitle: a summary that sanitizes to the placeholder -> null", () => {
  assert.equal(pickSdkTitle({ summary: "New thread" }, "Some existing title"), null);
});

it("pickSdkTitle: a summary equal to the current title -> null", () => {
  assert.equal(pickSdkTitle({ summary: "Fix the parser" }, "Fix the parser"), null);
});

it("pickSdkTitle: a good distinct summary -> the sanitized title", () => {
  assert.equal(pickSdkTitle({ summary: "  Fix the parser bug  " }, DEFAULT_TITLE), "Fix the parser bug");
  // Surrounding quotes are stripped by sanitizeThreadTitle.
  assert.equal(
    pickSdkTitle({ summary: '"Refactor the auth module"' }, DEFAULT_TITLE),
    "Refactor the auth module",
  );
});

// ===========================================================================
// EFFECT: resolveRenameTitle (provide only the snapshot-query stub)
// ===========================================================================

it.effect("resolveRenameTitle: returns the SDK title when the summary is ready on the first read", () =>
  Effect.gen(function* () {
    const { dispatchRename } = makeRecorder();
    const deps: SdkTitleDeps = {
      readSessionTitle: readSeq([{ summary: "Fix the parser bug" }]),
      dispatchRename,
      handled: new Set(),
      titleSeeds: new Map(),
      maxAttempts: 1,
      delayMillis: 0,
    };
    const title = yield* resolveRenameTitle({
      threadId: THREAD_ID,
      sessionId: CLAUDE_SESSION_ID,
      dir: WORKSPACE_ROOT,
      deps,
    });
    assert.equal(title, "Fix the parser bug");
  }).pipe(
    Effect.provideService(
      ProjectionSnapshotQuery,
      makeSnapshotService({
        thread: () => Option.some(makeThread(DEFAULT_TITLE, [{ role: "user", text: "do x" }])),
      }),
    ),
  ),
);

it.effect(
  "resolveRenameTitle: gates on the captured raw seed even when the stored first message is transformed",
  () =>
    Effect.gen(function* () {
      const { dispatchRename } = makeRecorder();
      const deps: SdkTitleDeps = {
        readSessionTitle: readSeq([{ summary: "Auth module refactor" }]),
        dispatchRename,
        handled: new Set(),
        // Captured raw seed equals the title the client set; the stored message
        // is the ultrathink-transformed text (which would mismatch on its own).
        titleSeeds: new Map([[THREAD_ID, "Refactor the auth module"]]),
        maxAttempts: 1,
        delayMillis: 0,
      };
      const title = yield* resolveRenameTitle({
        threadId: THREAD_ID,
        sessionId: CLAUDE_SESSION_ID,
        dir: WORKSPACE_ROOT,
        deps,
      });
      assert.equal(title, "Auth module refactor");
    }).pipe(
      Effect.provideService(
        ProjectionSnapshotQuery,
        makeSnapshotService({
          thread: () =>
            Option.some(
              makeThread("Refactor the auth module", [
                { role: "user", text: "Ultrathink:\nRefactor the auth module" },
              ]),
            ),
        }),
      ),
    ),
);

it.effect("resolveRenameTitle: polls again and returns the title once it becomes ready", () =>
  Effect.gen(function* () {
    const { dispatchRename } = makeRecorder();
    const deps: SdkTitleDeps = {
      // First read: summary === firstPrompt -> not ready. Second: a real summary.
      readSessionTitle: readSeq([
        { summary: "do x", firstPrompt: "do x" },
        { summary: "Implement the cache" },
      ]),
      dispatchRename,
      handled: new Set(),
      titleSeeds: new Map(),
      maxAttempts: 2,
      delayMillis: 0,
    };
    const title = yield* resolveRenameTitle({
      threadId: THREAD_ID,
      sessionId: CLAUDE_SESSION_ID,
      dir: undefined,
      deps,
    });
    assert.equal(title, "Implement the cache");
  }).pipe(
    Effect.provideService(
      ProjectionSnapshotQuery,
      makeSnapshotService({
        thread: () => Option.some(makeThread(DEFAULT_TITLE, [{ role: "user", text: "do x" }])),
      }),
    ),
  ),
);

it.effect("resolveRenameTitle: returns null when the summary never becomes ready", () =>
  Effect.gen(function* () {
    const { dispatchRename } = makeRecorder();
    const deps: SdkTitleDeps = {
      readSessionTitle: readSeq([undefined]),
      dispatchRename,
      handled: new Set(),
      titleSeeds: new Map(),
      maxAttempts: 2,
      delayMillis: 0,
    };
    const title = yield* resolveRenameTitle({
      threadId: THREAD_ID,
      sessionId: CLAUDE_SESSION_ID,
      dir: WORKSPACE_ROOT,
      deps,
    });
    assert.equal(title, null);
  }).pipe(
    Effect.provideService(
      ProjectionSnapshotQuery,
      makeSnapshotService({
        thread: () => Option.some(makeThread(DEFAULT_TITLE, [{ role: "user", text: "do x" }])),
      }),
    ),
  ),
);

it.effect("resolveRenameTitle: stops (returns null) when the title is user-renamed mid-poll", () =>
  Effect.gen(function* () {
    const { dispatchRename } = makeRecorder();
    const deps: SdkTitleDeps = {
      // Never ready, so attempt 0 keeps polling into attempt 1.
      readSessionTitle: readSeq([{ summary: "do x", firstPrompt: "do x" }]),
      dispatchRename,
      handled: new Set(),
      titleSeeds: new Map(),
      maxAttempts: 2,
      delayMillis: 0,
    };
    const title = yield* resolveRenameTitle({
      threadId: THREAD_ID,
      sessionId: CLAUDE_SESSION_ID,
      dir: WORKSPACE_ROOT,
      deps,
    });
    assert.equal(title, null);
  }).pipe(
    Effect.provideService(
      ProjectionSnapshotQuery,
      makeSnapshotService({
        // Attempt 0: still the placeholder (replaceable). Attempt 1: the user
        // has renamed it to something that is neither default nor the seed.
        thread: (call) =>
          Option.some(
            call === 0
              ? makeThread(DEFAULT_TITLE, [{ role: "user", text: "do x" }])
              : makeThread("User chose this", [{ role: "user", text: "do x" }]),
          ),
      }),
    ),
  ),
);

it.effect("resolveRenameTitle: returns null when the thread no longer exists", () =>
  Effect.gen(function* () {
    const { dispatchRename } = makeRecorder();
    const deps: SdkTitleDeps = {
      readSessionTitle: readShouldNotRun,
      dispatchRename,
      handled: new Set(),
      titleSeeds: new Map(),
      maxAttempts: 2,
      delayMillis: 0,
    };
    const title = yield* resolveRenameTitle({
      threadId: THREAD_ID,
      sessionId: CLAUDE_SESSION_ID,
      dir: WORKSPACE_ROOT,
      deps,
    });
    assert.equal(title, null);
  }).pipe(
    Effect.provideService(
      ProjectionSnapshotQuery,
      makeSnapshotService({ thread: () => Option.none() }),
    ),
  ),
);

// ===========================================================================
// EFFECT: handleTurnDiffCompleted gating (real ProviderSessionDirectory)
// ===========================================================================

const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
  Layer.provide(SqlitePersistenceMemory),
);
const baseLayers = Layer.mergeAll(
  runtimeRepositoryLayer,
  ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer)),
  NodeServices.layer,
);

const seedBinding = (threadId: ThreadId, provider: string, resumeCursor: unknown) =>
  Effect.gen(function* () {
    const directory = yield* ProviderSessionDirectory;
    yield* directory.upsert({
      threadId,
      provider: provider as never,
      providerInstanceId: INSTANCE_ID,
      status: "stopped",
      runtimeMode: "full-access",
      resumeCursor,
    });
  });

it.layer(baseLayers)("SdkTitleReactor.handleTurnDiffCompleted", (it) => {
  it.effect(
    "dispatches the sanitized SDK title for a Claude thread with a replaceable title + ready summary",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-claude");
        yield* seedBinding(threadId, "claudeAgent", { resume: CLAUDE_SESSION_ID });

        const { calls, dispatchRename } = makeRecorder();
        const deps: SdkTitleDeps = {
          // Summary needs sanitizing (quotes + padding) to prove the reactor sanitizes.
          readSessionTitle: readSeq([{ summary: '  "Refactor the parser"  ' }]),
          dispatchRename,
          handled: new Set(),
          titleSeeds: new Map(),
          maxAttempts: 1,
          delayMillis: 0,
        };

        yield* handleTurnDiffCompleted(threadId, deps).pipe(
          Effect.provideService(
            ProjectionSnapshotQuery,
            makeSnapshotService({
              thread: () => Option.some(makeThread(DEFAULT_TITLE, [{ role: "user", text: "do x" }])),
              project: projectShellSome,
            }),
          ),
        );
        yield* settle;

        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], { threadId, title: "Refactor the parser" });
      }),
  );

  // ---- C1: the previously-broken first-message shapes. For each, the client
  // titles the thread from the RAW prompt while storing a TRANSFORMED first
  // message; the captured raw seed makes the title replaceable where the
  // reconstructed-from-message seed would have mismatched and silently skipped.

  const brokenShape = (input: {
    readonly name: string;
    readonly threadSuffix: string;
    readonly rawSeed: string;
    readonly storedText: string;
    readonly summary: string;
    readonly expectedTitle: string;
  }) =>
    it.effect(`applies the SDK title for a ${input.name} first message (raw seed gate)`, () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(input.threadSuffix);
        yield* seedBinding(threadId, "claudeAgent", { resume: CLAUDE_SESSION_ID });

        // Sanity: the reconstructed seed would NOT match the title -> old bug.
        assert.notEqual(firstUserTitleSeed([{ role: "user", text: input.storedText }]), input.rawSeed);

        const { calls, dispatchRename } = makeRecorder();
        const deps: SdkTitleDeps = {
          readSessionTitle: readSeq([{ summary: input.summary }]),
          dispatchRename,
          handled: new Set(),
          titleSeeds: new Map([[threadId, input.rawSeed]]),
          maxAttempts: 1,
          delayMillis: 0,
        };

        yield* handleTurnDiffCompleted(threadId, deps).pipe(
          Effect.provideService(
            ProjectionSnapshotQuery,
            makeSnapshotService({
              thread: () =>
                Option.some(makeThread(input.rawSeed, [{ role: "user", text: input.storedText }])),
              project: projectShellSome,
            }),
          ),
        );
        yield* settle;

        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], { threadId, title: input.expectedTitle });
      }),
    );

  brokenShape({
    name: "ultrathink-prefixed",
    threadSuffix: "thread-ultrathink",
    rawSeed: "Refactor the auth module",
    storedText: "Ultrathink:\nRefactor the auth module",
    summary: "Auth module refactor",
    expectedTitle: "Auth module refactor",
  });

  brokenShape({
    name: "terminal-context-only",
    threadSuffix: "thread-terminal-only",
    rawSeed: "Investigate the failing build",
    storedText: "<terminal-context>\nnpm ERR! build failed\n</terminal-context>",
    summary: "Investigate failing build",
    expectedTitle: "Investigate failing build",
  });

  brokenShape({
    name: "short-text + terminal-context",
    threadSuffix: "thread-short-terminal",
    rawSeed: "fix lint",
    storedText: "fix lint\n\n<terminal-context>\neslint: 12 problems\n</terminal-context>",
    summary: "Fix lint errors",
    expectedTitle: "Fix lint errors",
  });

  brokenShape({
    name: "image-only bootstrap",
    threadSuffix: "thread-image-only",
    rawSeed: "Look at this screenshot",
    storedText: "Here is an uploaded image. Please analyze it.\n[image:001]",
    summary: "Analyze the screenshot",
    expectedTitle: "Analyze the screenshot",
  });

  it.effect(
    "fallback: with no captured seed, a plain-text first message whose title matches the reconstructed seed still titles",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-fallback-plain");
        yield* seedBinding(threadId, "claudeAgent", { resume: CLAUDE_SESSION_ID });

        const { calls, dispatchRename } = makeRecorder();
        const deps: SdkTitleDeps = {
          readSessionTitle: readSeq([{ summary: "Add the cache layer" }]),
          dispatchRename,
          handled: new Set(),
          // No captured seed -> falls back to firstUserTitleSeed(messages).
          titleSeeds: new Map(),
          maxAttempts: 1,
          delayMillis: 0,
        };

        yield* handleTurnDiffCompleted(threadId, deps).pipe(
          Effect.provideService(
            ProjectionSnapshotQuery,
            makeSnapshotService({
              // Title == the (untransformed) first message -> reconstructed seed matches.
              thread: () =>
                Option.some(makeThread("add a cache", [{ role: "user", text: "add a cache" }])),
              project: projectShellSome,
            }),
          ),
        );
        yield* settle;

        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], { threadId, title: "Add the cache layer" });
      }),
  );

  it.effect(
    "fallback regression guard: a transformed first message with NO captured seed is left untitled",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-fallback-transformed");
        yield* seedBinding(threadId, "claudeAgent", { resume: CLAUDE_SESSION_ID });

        const { calls, dispatchRename } = makeRecorder();
        const deps: SdkTitleDeps = {
          readSessionTitle: readShouldNotRun,
          dispatchRename,
          handled: new Set(),
          titleSeeds: new Map(),
          maxAttempts: 1,
          delayMillis: 0,
        };

        yield* handleTurnDiffCompleted(threadId, deps).pipe(
          Effect.provideService(
            ProjectionSnapshotQuery,
            makeSnapshotService({
              // Title is the raw seed; stored message is transformed and there is
              // no captured seed, so the reconstructed seed mismatches the title.
              thread: () =>
                Option.some(
                  makeThread("Refactor the auth module", [
                    { role: "user", text: "Ultrathink:\nRefactor the auth module" },
                  ]),
                ),
              project: projectShellSome,
            }),
          ),
        );
        yield* settle;

        assert.equal(calls.length, 0);
      }),
  );

  it.effect("does NOT dispatch for a non-Claude (codex) binding", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-codex");
      yield* seedBinding(threadId, "codex", { resume: CLAUDE_SESSION_ID });

      const { calls, dispatchRename } = makeRecorder();
      const deps: SdkTitleDeps = {
        readSessionTitle: readShouldNotRun,
        dispatchRename,
        handled: new Set(),
        titleSeeds: new Map(),
        maxAttempts: 1,
        delayMillis: 0,
      };

      yield* handleTurnDiffCompleted(threadId, deps).pipe(
        Effect.provideService(
          ProjectionSnapshotQuery,
          makeSnapshotService({
            thread: () => Option.some(makeThread(DEFAULT_TITLE, [{ role: "user", text: "do x" }])),
            project: projectShellSome,
          }),
        ),
      );
      yield* settle;

      assert.equal(calls.length, 0);
    }),
  );

  it.effect("does NOT dispatch when there is no provider binding", () =>
    Effect.gen(function* () {
      // Never seeded -> getBinding returns Option.none.
      const threadId = ThreadId.make("thread-no-binding");

      const { calls, dispatchRename } = makeRecorder();
      const deps: SdkTitleDeps = {
        readSessionTitle: readShouldNotRun,
        dispatchRename,
        handled: new Set(),
        titleSeeds: new Map(),
        maxAttempts: 1,
        delayMillis: 0,
      };

      yield* handleTurnDiffCompleted(threadId, deps).pipe(
        Effect.provideService(
          ProjectionSnapshotQuery,
          makeSnapshotService({
            thread: () => Option.some(makeThread(DEFAULT_TITLE, [{ role: "user", text: "do x" }])),
            project: projectShellSome,
          }),
        ),
      );
      yield* settle;

      assert.equal(calls.length, 0);
    }),
  );

  it.effect("does NOT dispatch when the Claude binding carries no session id", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-no-sid");
      yield* seedBinding(threadId, "claudeAgent", { threadId });

      const { calls, dispatchRename } = makeRecorder();
      const deps: SdkTitleDeps = {
        readSessionTitle: readShouldNotRun,
        dispatchRename,
        handled: new Set(),
        titleSeeds: new Map(),
        maxAttempts: 1,
        delayMillis: 0,
      };

      yield* handleTurnDiffCompleted(threadId, deps).pipe(
        Effect.provideService(
          ProjectionSnapshotQuery,
          makeSnapshotService({
            thread: () => Option.some(makeThread(DEFAULT_TITLE, [{ role: "user", text: "do x" }])),
            project: projectShellSome,
          }),
        ),
      );
      yield* settle;

      assert.equal(calls.length, 0);
    }),
  );

  it.effect("does NOT dispatch when the title was already user-renamed", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-renamed");
      yield* seedBinding(threadId, "claudeAgent", { resume: CLAUDE_SESSION_ID });

      const { calls, dispatchRename } = makeRecorder();
      const deps: SdkTitleDeps = {
        readSessionTitle: readShouldNotRun,
        dispatchRename,
        handled: new Set(),
        titleSeeds: new Map(),
        maxAttempts: 1,
        delayMillis: 0,
      };

      yield* handleTurnDiffCompleted(threadId, deps).pipe(
        Effect.provideService(
          ProjectionSnapshotQuery,
          makeSnapshotService({
            // Title is neither the placeholder nor the message seed -> not replaceable.
            thread: () =>
              Option.some(makeThread("User picked this", [{ role: "user", text: "do x" }])),
            project: projectShellSome,
          }),
        ),
      );
      yield* settle;

      assert.equal(calls.length, 0);
    }),
  );
});
