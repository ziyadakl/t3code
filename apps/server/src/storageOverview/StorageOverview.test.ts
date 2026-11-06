import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as Settings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as StorageOverview from "./StorageOverview.ts";

const testLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "storage-overview-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | FileSystem.FileSystem
    | ServerConfig.ServerConfig
    | GitVcsDriver.GitVcsDriver
    | Path.Path
    | Scope.Scope
  >,
) => effect.pipe(Effect.provide(testLayer), Effect.scoped);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const repo = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "overview-repo-" }));
  const command = (cwd: string, args: string[]) =>
    git.execute({ operation: "overview-test", cwd, args });
  yield* command(repo, ["init", "-b", "main"]);
  yield* command(repo, ["config", "user.email", "overview@example.test"]);
  yield* command(repo, ["config", "user.name", "Overview test"]);
  yield* fs.writeFileString(`${repo}/tracked.txt`, "original\n");
  yield* command(repo, ["add", "."]);
  yield* command(repo, ["commit", "-m", "initial"]);
  yield* fs.makeDirectory(config.worktreesDir, { recursive: true });
  const worktree = `${yield* fs.realPath(config.worktreesDir)}/repository/feature`;
  yield* command(repo, ["worktree", "add", "-b", "feature", worktree]);

  const projectId = ProjectId.make("project-1");
  const threadId = ThreadId.make("thread-1");
  const context = yield* Layer.build(StorageOverview.layer).pipe(
    Effect.provideService(GitVcsDriver.GitVcsDriver, git),
    Effect.provideService(Settings.ServerSettingsService, {
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    } as unknown as Settings.ServerSettingsService["Service"]),
    Effect.provideService(ProjectStore.ProjectStoreV2, {
      list: () => Effect.succeed([{ workspaceRoot: repo }]),
      listShells: () =>
        Effect.succeed([{ id: projectId, title: "Repo title", workspaceRoot: repo }]),
    } as unknown as ProjectStore.ProjectStoreV2["Service"]),
    Effect.provideService(ProjectionStore.ProjectionStoreV2, {
      getShellSnapshot: () =>
        Effect.succeed({
          threads: [{ id: threadId, projectId, title: "Build it", worktreePath: worktree }],
          archivedThreads: [],
        }),
    } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
    Effect.provideService(ProviderSessionManager.ProviderSessionManagerV2, {
      isLive: () => Effect.succeed(false),
    } as unknown as ProviderSessionManager.ProviderSessionManagerV2["Service"]),
    Effect.provideService(SqlClient.SqlClient, (() =>
      Effect.succeed([])) as unknown as SqlClient.SqlClient),
    Effect.provideService(GitManager.GitManager, {
      invalidateStatus: () => Effect.void,
    } as unknown as GitManager.GitManager["Service"]),
  );
  return {
    service: Context.get(context, StorageOverview.StorageOverview),
    fs,
    repo,
    worktree,
    threadId,
    command,
  };
});

describe("StorageOverview", () => {
  it.live("lists a worktree with its size, branch and thread", () =>
    run(
      Effect.gen(function* () {
        const { service, worktree, repo, threadId } = yield* fixture;
        const overview = yield* service.get({});
        expect(overview.worktrees).toHaveLength(1);
        const [entry] = overview.worktrees;
        expect(entry).toMatchObject({
          path: worktree,
          projectRoot: repo,
          projectName: repo.split("/").pop(),
          branch: "feature",
          uncommittedFiles: 0,
          threads: [{ threadId, title: "Build it", archived: false }],
        });
        expect(entry!.bytes).toBeGreaterThan(0);
        const worktreesCategory = overview.categories.find((c) => c.key === "worktrees");
        expect(worktreesCategory?.bytes).toBe(entry!.bytes);
        expect(overview.totalBytes).toBeGreaterThanOrEqual(worktreesCategory!.bytes);
      }),
    ),
  );

  it.live("refuses to remove a folder outside the managed roots", () =>
    run(
      Effect.gen(function* () {
        const { service, fs, repo } = yield* fixture;
        const error = yield* service
          .removeWorktree({ path: repo, discardChanges: true })
          .pipe(Effect.flip);
        expect(error.message).toContain("outside the managed worktree folders");
        expect(yield* fs.exists(`${repo}/tracked.txt`)).toBe(true);
      }),
    ),
  );

  it.live("refuses a dirty worktree without discardChanges, then removes it with it", () =>
    run(
      Effect.gen(function* () {
        const { service, fs, worktree, command, repo } = yield* fixture;
        yield* fs.writeFileString(`${worktree}/scratch.txt`, "unsaved\n");
        const dirty = yield* service.get({ refresh: true });
        expect(dirty.worktrees[0]?.uncommittedFiles).toBe(1);

        const error = yield* service
          .removeWorktree({ path: worktree, discardChanges: false })
          .pipe(Effect.flip);
        expect(error.message).toContain("modified or untracked files");
        expect(yield* fs.exists(worktree)).toBe(true);

        const removed = yield* service.removeWorktree({ path: worktree, discardChanges: true });
        expect(removed.bytesFreed).toBeGreaterThan(0);
        expect(yield* fs.exists(worktree)).toBe(false);
        // The branch stays so a thread can rebuild the folder.
        expect((yield* command(repo, ["rev-parse", "--verify", "feature"])).exitCode).toBe(0);
        expect((yield* service.get({})).worktrees).toEqual([]);
      }),
    ),
  );
});
