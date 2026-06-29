import { assert, it, describe } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type { RepositoryIdentity } from "@t3tools/contracts";

import {
  GitHubCli,
  GitHubCliError,
  type DispatchReadyIssue,
  type GitHubCliShape,
} from "../sourceControl/GitHubCli.ts";
import { RepositoryIdentityResolver } from "../project/Services/RepositoryIdentityResolver.ts";
import {
  QueueReadyCache,
  makeQueueReadyCache,
  type QueueReadyCacheOptions,
} from "./QueueReadyCache.ts";

const LABEL = "ready-for-agent";
const CWD = "/repo";

type DispatchCandidates = {
  readonly ready: ReadonlyArray<DispatchReadyIssue>;
  readonly openNumbers: ReadonlyArray<number>;
};

/** Counts how many times each gh query method the cache uses was invoked. */
type GhCallCounter = { byLabel: number; numbers: number };

const githubIdentity: RepositoryIdentity = {
  canonicalKey: "github.com/acme/widgets",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "https://github.com/acme/widgets.git",
  },
  provider: "github",
  owner: "acme",
  name: "widgets",
};

const unauthedError = () =>
  new GitHubCliError({
    operation: "listOpenIssuesByLabel",
    reason: "unauthed",
    detail: "GitHub CLI is not authenticated. Run `gh auth login` and retry.",
  });

/** `n` clean ready issues (no labels, empty body, no blockers) so
 *  countDispatchableIssues returns exactly `n` when SANDCASTLE.md is absent.
 *  Lets the count-oriented tests below keep expressing expectations as a number. */
const readyOfLength = (n: number): DispatchCandidates => ({
  ready: Array.from({ length: n }, (_, i) => ({ number: i + 1, body: "", labels: [] as string[] })),
  openNumbers: [],
});

/** A GitHubCli whose only meaningful methods are the two dispatch queries; the
 *  rest fail (they should never be called by QueueReadyCache). Both queries are
 *  derived from a single `candidates` source so the count-oriented tests keep
 *  expressing one outcome; `counter` records how often each was invoked so a test
 *  can assert the open-issue-number query is skipped. */
function fakeGitHubCli(
  candidates: () => Effect.Effect<DispatchCandidates, GitHubCliError>,
  counter?: GhCallCounter,
): GitHubCliShape {
  const unexpected = (operation: string) =>
    Effect.fail(new GitHubCliError({ operation, reason: "other", detail: "unexpected call" }));
  return {
    execute: () => unexpected("execute"),
    listOpenPullRequests: () => unexpected("listOpenPullRequests"),
    listOpenIssuesByLabel: () => {
      if (counter) counter.byLabel += 1;
      return candidates().pipe(Effect.map((c) => c.ready));
    },
    listOpenIssueNumbers: () => {
      if (counter) counter.numbers += 1;
      return candidates().pipe(Effect.map((c) => c.openNumbers));
    },
    getPullRequest: () => unexpected("getPullRequest"),
    getRepositoryCloneUrls: () => unexpected("getRepositoryCloneUrls"),
    createRepository: () => unexpected("createRepository"),
    createPullRequest: () => unexpected("createPullRequest"),
    getDefaultBranch: () => unexpected("getDefaultBranch"),
    checkoutPullRequest: () => unexpected("checkoutPullRequest"),
  };
}

function cacheLayer(args: {
  /** Number-based dispatchable count for the SWR/identity/in-flight tests
   *  (SANDCASTLE.md absent ⇒ this many dispatchable). Ignored when `dispatch` is set. */
  readonly count?: () => Effect.Effect<number, GitHubCliError>;
  /** Explicit candidates for the end-to-end dispatch test. Takes precedence over `count`. */
  readonly dispatch?: () => Effect.Effect<DispatchCandidates, GitHubCliError>;
  readonly identity: RepositoryIdentity | null;
  readonly options?: QueueReadyCacheOptions;
  /** Optional counter incremented once per `resolve` invocation (memo-hit check). */
  readonly resolveCounter?: { calls: number };
  /** Optional counter recording each gh dispatch-query invocation (skip check). */
  readonly ghCounter?: GhCallCounter;
  /** What the fake FileSystem reports for `<rootPath>/SANDCASTLE.md` (default false). */
  readonly sandcastleMdExists?: boolean;
}): Layer.Layer<QueueReadyCache> {
  const candidates =
    args.dispatch ??
    (() => (args.count ?? (() => Effect.succeed(0)))().pipe(Effect.map(readyOfLength)));
  return Layer.effect(QueueReadyCache, makeQueueReadyCache(args.options ?? {})).pipe(
    Layer.provide(Layer.succeed(GitHubCli, fakeGitHubCli(candidates, args.ghCounter))),
    Layer.provide(
      FileSystem.layerNoop({
        exists: () => Effect.succeed(args.sandcastleMdExists ?? false),
      }),
    ),
    Layer.provide(
      Layer.succeed(RepositoryIdentityResolver, {
        resolve: () => {
          if (args.resolveCounter) args.resolveCounter.calls += 1;
          return Effect.succeed(args.identity);
        },
      }),
    ),
  );
}

describe("QueueReadyCache", () => {
  it.live("reports the queue-ready count once the background refresh lands", () =>
    Effect.gen(function* () {
      const cache = yield* QueueReadyCache;
      // First observe forks the refresh and returns a pending status.
      const pending = yield* cache.observe(CWD, LABEL);
      assert.equal(pending?.count, null);
      yield* Effect.sleep("20 millis");
      const settled = yield* cache.observe(CWD, LABEL);
      assert.equal(settled?.count, 3);
      assert.equal(settled?.error, null);
      assert.equal(settled?.label, LABEL);
    }).pipe(
      Effect.provide(cacheLayer({ count: () => Effect.succeed(3), identity: githubIdentity })),
    ),
  );

  it.live(
    "counts only the dispatchable issues end-to-end (type: + blocked-by rules, SANDCASTLE.md present)",
    () =>
      Effect.gen(function* () {
        const cache = yield* QueueReadyCache;
        yield* cache.observe(CWD, LABEL);
        yield* Effect.sleep("20 millis");
        const status = yield* cache.observe(CWD, LABEL);
        // #10 typeless ⇒ excluded; #11 blocked by open #99 ⇒ excluded; #12 has one
        // type: label and no open blocker ⇒ kept. So exactly one is dispatchable.
        assert.equal(status?.count, 1);
        assert.equal(status?.error, null);
      }).pipe(
        Effect.provide(
          cacheLayer({
            identity: { ...githubIdentity, rootPath: "/repo-root" },
            sandcastleMdExists: true,
            dispatch: () =>
              Effect.succeed({
                ready: [
                  { number: 10, body: "", labels: ["ready-for-agent"] },
                  { number: 11, body: "Blocked by: #99", labels: ["ready-for-agent", "type:feature"] },
                  { number: 12, body: "", labels: ["ready-for-agent", "type:bug"] },
                ],
                openNumbers: [10, 11, 12, 99],
              }),
          }),
        ),
      ),
  );

  it.live(
    "skips the open-issue-number query when no ready issue declares a blocker",
    () => {
      // The open-issue set exists only to resolve `Blocked by: #N`; with no ready
      // issue declaring one, that second gh subprocess is pure waste — it must not run.
      const ghCounter: GhCallCounter = { byLabel: 0, numbers: 0 };
      return Effect.gen(function* () {
        const cache = yield* QueueReadyCache;
        yield* cache.observe(CWD, LABEL);
        yield* Effect.sleep("20 millis");
        const status = yield* cache.observe(CWD, LABEL);
        assert.equal(status?.count, 2); // both ready issues dispatchable
        assert.equal(status?.error, null);
        assert.equal(ghCounter.byLabel, 1);
        assert.equal(ghCounter.numbers, 0); // open-issue-number query skipped
      }).pipe(
        Effect.provide(
          cacheLayer({
            identity: githubIdentity,
            ghCounter,
            dispatch: () =>
              Effect.succeed({
                ready: [
                  { number: 1, body: "", labels: [] },
                  { number: 2, body: "no blockers in this body", labels: [] },
                ],
                openNumbers: [1, 2],
              }),
          }),
        ),
      );
    },
  );

  it.live(
    "queries the open-issue-number set (and excludes the blocked issue) when a ready issue declares a blocker",
    () => {
      const ghCounter: GhCallCounter = { byLabel: 0, numbers: 0 };
      return Effect.gen(function* () {
        const cache = yield* QueueReadyCache;
        yield* cache.observe(CWD, LABEL);
        yield* Effect.sleep("20 millis");
        const status = yield* cache.observe(CWD, LABEL);
        // #1 is blocked by still-open #2 ⇒ excluded; #3 has no blocker ⇒ kept.
        assert.equal(status?.count, 1);
        assert.equal(status?.error, null);
        assert.equal(ghCounter.byLabel, 1);
        assert.equal(ghCounter.numbers, 1); // open-issue-number query performed
      }).pipe(
        Effect.provide(
          cacheLayer({
            identity: githubIdentity,
            ghCounter,
            dispatch: () =>
              Effect.succeed({
                ready: [
                  { number: 1, body: "Blocked by: #2", labels: [] },
                  { number: 3, body: "", labels: [] },
                ],
                openNumbers: [1, 2, 3],
              }),
          }),
        ),
      );
    },
  );

  it.live("returns null for a project whose repo isn't GitHub", () =>
    Effect.gen(function* () {
      const cache = yield* QueueReadyCache;
      const status = yield* cache.observe(CWD, LABEL);
      assert.equal(status, null);
    }).pipe(Effect.provide(cacheLayer({ count: () => Effect.succeed(0), identity: null }))),
  );

  it.live("marks the status unavailable when gh is not authenticated", () =>
    Effect.gen(function* () {
      const cache = yield* QueueReadyCache;
      yield* cache.observe(CWD, LABEL);
      yield* Effect.sleep("20 millis");
      const status = yield* cache.observe(CWD, LABEL);
      assert.equal(status?.error, "gh-unauthed");
      assert.equal(status?.count, null);
    }).pipe(
      Effect.provide(
        cacheLayer({ count: () => Effect.fail(unauthedError()), identity: githubIdentity }),
      ),
    ),
  );

  it.live("keeps the last good count when a later refresh fails (stale-while-revalidate)", () => {
    let mode: "ok" | "fail" = "ok";
    const count = () => (mode === "ok" ? Effect.succeed(3) : Effect.fail(unauthedError()));
    return Effect.gen(function* () {
      const cache = yield* QueueReadyCache;
      yield* cache.observe(CWD, LABEL);
      yield* Effect.sleep("20 millis");
      const first = yield* cache.observe(CWD, LABEL);
      assert.equal(first?.count, 3);

      // Force the next observe to refresh (tiny TTL) into a failing query.
      mode = "fail";
      yield* Effect.sleep("10 millis");
      yield* cache.observe(CWD, LABEL);
      yield* Effect.sleep("20 millis");
      const second = yield* cache.observe(CWD, LABEL);
      assert.equal(second?.count, 3); // prior count preserved
      assert.equal(second?.error, "gh-unauthed");
    }).pipe(
      Effect.provide(
        cacheLayer({ count, identity: githubIdentity, options: { freshTtl: Duration.millis(1) } }),
      ),
    );
  });

  it.live("classifies by error.reason, not by the human-readable detail text", () =>
    Effect.gen(function* () {
      const cache = yield* QueueReadyCache;
      yield* cache.observe(CWD, LABEL);
      yield* Effect.sleep("20 millis");
      const status = yield* cache.observe(CWD, LABEL);
      // The detail deliberately contains none of the old substrings; the wire
      // marker must come from `reason: "missing"` alone.
      assert.equal(status?.error, "gh-missing");
    }).pipe(
      Effect.provide(
        cacheLayer({
          count: () =>
            Effect.fail(
              new GitHubCliError({
                operation: "listOpenIssuesByLabel",
                reason: "missing",
                detail: "an opaque boundary message",
              }),
            ),
          identity: githubIdentity,
        }),
      ),
    ),
  );

  it.effect(
    "resolves a cwd's identity at most once across repeated observes within the identity TTL",
    () => {
      // The whole point of QueueReadyCache is to keep subprocesses off the ~2s
      // poll path. `resolver.resolve` runs an uncached `git rev-parse`, so it
      // must be memoized: many observes of the same cwd => exactly one resolve.
      const resolveCounter = { calls: 0 };
      return Effect.gen(function* () {
        const cache = yield* QueueReadyCache;
        yield* cache.observe(CWD, LABEL);
        yield* cache.observe(CWD, LABEL);
        yield* cache.observe(CWD, LABEL);
        assert.equal(resolveCounter.calls, 1);
      }).pipe(
        Effect.provide(
          cacheLayer({ count: () => Effect.succeed(0), identity: githubIdentity, resolveCounter }),
        ),
      );
    },
  );

  it.live("releases the in-flight slot when a refresh dies (defect)", () => {
    let calls = 0;
    const count = () => {
      calls += 1;
      return Effect.die(new Error("boom"));
    };
    return Effect.gen(function* () {
      const cache = yield* QueueReadyCache;
      // First observe forks a refresh that dies before updating the status. The
      // `ensuring` guard must still release the in-flight slot...
      yield* cache.observe(CWD, LABEL);
      yield* Effect.sleep("20 millis");
      // ...so this second observe is free to fork another refresh. If the slot
      // were stranded, count() would have been called only once.
      yield* cache.observe(CWD, LABEL);
      yield* Effect.sleep("20 millis");
      assert.equal(calls, 2);
    }).pipe(Effect.provide(cacheLayer({ count, identity: githubIdentity })));
  });
});
