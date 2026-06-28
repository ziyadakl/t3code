import { assert, it, describe } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { RepositoryIdentity } from "@t3tools/contracts";

import { GitHubCli, GitHubCliError, type GitHubCliShape } from "../sourceControl/GitHubCli.ts";
import { RepositoryIdentityResolver } from "../project/Services/RepositoryIdentityResolver.ts";
import {
  QueueReadyCache,
  makeQueueReadyCache,
  type QueueReadyCacheOptions,
} from "./QueueReadyCache.ts";

const LABEL = "ready-for-agent";
const CWD = "/repo";

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
    operation: "countOpenIssuesByLabel",
    detail: "GitHub CLI is not authenticated. Run `gh auth login` and retry.",
  });

/** A GitHubCli whose only meaningful method is countOpenIssuesByLabel; the rest
 *  fail (they should never be called by QueueReadyCache). */
function fakeGitHubCli(count: () => Effect.Effect<number, GitHubCliError>): GitHubCliShape {
  const unexpected = (operation: string) =>
    Effect.fail(new GitHubCliError({ operation, detail: "unexpected call" }));
  return {
    execute: () => unexpected("execute"),
    listOpenPullRequests: () => unexpected("listOpenPullRequests"),
    countOpenIssuesByLabel: () => count(),
    getPullRequest: () => unexpected("getPullRequest"),
    getRepositoryCloneUrls: () => unexpected("getRepositoryCloneUrls"),
    createRepository: () => unexpected("createRepository"),
    createPullRequest: () => unexpected("createPullRequest"),
    getDefaultBranch: () => unexpected("getDefaultBranch"),
    checkoutPullRequest: () => unexpected("checkoutPullRequest"),
  };
}

function cacheLayer(args: {
  readonly count: () => Effect.Effect<number, GitHubCliError>;
  readonly identity: RepositoryIdentity | null;
  readonly options?: QueueReadyCacheOptions;
}): Layer.Layer<QueueReadyCache> {
  return Layer.effect(QueueReadyCache, makeQueueReadyCache(args.options ?? {})).pipe(
    Layer.provide(Layer.succeed(GitHubCli, fakeGitHubCli(args.count))),
    Layer.provide(
      Layer.succeed(RepositoryIdentityResolver, {
        resolve: () => Effect.succeed(args.identity),
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
});
