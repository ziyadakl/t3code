import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ThreadId,
  type TerminalMetadataStreamEvent,
} from "@t3tools/contracts";
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
import * as TerminalManager from "../terminal/Manager.ts";
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
  let terminalListener: ((event: TerminalMetadataStreamEvent) => Effect.Effect<void>) | undefined;
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
    Effect.provideService(TerminalManager.TerminalManager, {
      subscribeMetadata: (listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>) =>
        Effect.sync(() => {
          terminalListener = listener;
          return () => {};
        }),
    } as unknown as TerminalManager.TerminalManager["Service"]),
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
    openTerminal: (cwd: string) =>
      terminalListener?.({
        type: "upsert",
        terminal: {
          threadId: "thread-1",
          terminalId: "terminal-1",
          status: "running",
          pid: 1,
          exitCode: null,
          exitSignal: null,
          hasRunningSubprocess: false,
          label: "Terminal",
          updatedAt: "2026-06-10T12:00:00.000Z",
          cwd,
          worktreePath: null,
        },
      }) ?? Effect.void,
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
          .removeWorktree({ path: repo, allowUncommittedFiles: 0 })
          .pipe(Effect.flip);
        expect(error.message).toContain("outside the managed worktree folders");
        expect(yield* fs.exists(`${repo}/tracked.txt`)).toBe(true);
      }),
    ),
  );

  it.live(
    "refuses when more files changed than the user was told, then removes with the right count",
    () =>
      run(
        Effect.gen(function* () {
          const { service, fs, worktree, command, repo } = yield* fixture;
          yield* fs.writeFileString(`${worktree}/scratch.txt`, "unsaved\n");
          const dirty = yield* service.get({ refresh: true });
          expect(dirty.worktrees[0]?.uncommittedFiles).toBe(1);

          const error = yield* service
            .removeWorktree({ path: worktree, allowUncommittedFiles: 0 })
            .pipe(Effect.flip);
          expect(error.message).toContain("Files changed since the list loaded");
          expect(yield* fs.exists(worktree)).toBe(true);

          const removed = yield* service.removeWorktree({
            path: worktree,
            allowUncommittedFiles: 1,
          });
          expect(removed.bytesFreed).toBeGreaterThan(0);
          expect(yield* fs.exists(worktree)).toBe(false);
          // The branch stays so a thread can rebuild the folder.
          expect((yield* command(repo, ["rev-parse", "--verify", "feature"])).exitCode).toBe(0);
          expect((yield* service.get({})).worktrees).toEqual([]);
        }),
      ),
  );

  it.live("counts every file inside a new folder, and refuses when one is added there", () =>
    run(
      Effect.gen(function* () {
        const { service, fs, worktree } = yield* fixture;
        yield* fs.makeDirectory(`${worktree}/generated`);
        for (const name of ["a.txt", "b.txt", "c.txt"])
          yield* fs.writeFileString(`${worktree}/generated/${name}`, "unsaved\n");
        const dirty = yield* service.get({ refresh: true });
        expect(dirty.worktrees[0]?.uncommittedFiles).toBe(3);

        yield* fs.writeFileString(`${worktree}/generated/d.txt`, "unsaved\n");
        const error = yield* service
          .removeWorktree({ path: worktree, allowUncommittedFiles: 3 })
          .pipe(Effect.flip);
        expect(error.message).toContain("Files changed since the list loaded");
        expect(yield* fs.exists(worktree)).toBe(true);
      }),
    ),
  );

  it.live("saves changes on the branch, then removes the worktree", () =>
    run(
      Effect.gen(function* () {
        const { service, fs, worktree, command, repo } = yield* fixture;
        yield* fs.writeFileString(`${worktree}/tracked.txt`, "edited\n");
        yield* fs.makeDirectory(`${worktree}/generated`);
        yield* fs.writeFileString(`${worktree}/generated/a.txt`, "alpha\n");
        yield* fs.writeFileString(`${worktree}/generated/b.txt`, "beta\n");

        const removed = yield* service.removeWorktree({
          path: worktree,
          allowUncommittedFiles: 3,
          saveChanges: true,
        });
        expect(removed.savedCommit).not.toBeNull();
        expect(yield* fs.exists(worktree)).toBe(false);
        expect((yield* command(repo, ["log", "-1", "--format=%s", "feature"])).stdout.trim()).toBe(
          "Saved before deleting the worktree",
        );
        expect((yield* command(repo, ["show", "feature:generated/a.txt"])).stdout).toBe("alpha\n");
        expect((yield* command(repo, ["show", "feature:tracked.txt"])).stdout).toBe("edited\n");
      }),
    ),
  );

  it.live("refuses to save an unignored .env file, unstages it and keeps the folder", () =>
    run(
      Effect.gen(function* () {
        const { service, fs, worktree, command } = yield* fixture;
        yield* fs.writeFileString(`${worktree}/.env.local`, "KEY=1\n");
        const error = yield* service
          .removeWorktree({ path: worktree, allowUncommittedFiles: 1, saveChanges: true })
          .pipe(Effect.flip);
        expect(error.message).toContain(".env file isn't ignored");
        expect(yield* fs.exists(worktree)).toBe(true);
        expect((yield* command(worktree, ["diff", "--cached", "--name-only"])).stdout).toBe("");
      }),
    ),
  );

  it.live("fills only the missing identity part when saving", () =>
    run(
      Effect.gen(function* () {
        const { service, fs, worktree, command, repo } = yield* fixture;
        yield* command(repo, ["config", "user.email", ""]);
        yield* fs.writeFileString(`${worktree}/note.txt`, "x\n");
        yield* service.removeWorktree({
          path: worktree,
          allowUncommittedFiles: 1,
          saveChanges: true,
        });
        const author = (yield* command(repo, [
          "log",
          "-1",
          "--format=%an <%ae>",
          "feature",
        ])).stdout.trim();
        expect(author).toBe("Overview test <t3code@localhost>");
      }),
    ),
  );

  it.live("refuses to save changes in a detached worktree and keeps the folder", () =>
    run(
      Effect.gen(function* () {
        const { service, fs, worktree, command } = yield* fixture;
        yield* command(worktree, ["checkout", "--detach"]);
        yield* fs.writeFileString(`${worktree}/scratch.txt`, "unsaved\n");
        const error = yield* service
          .removeWorktree({ path: worktree, allowUncommittedFiles: 1, saveChanges: true })
          .pipe(Effect.flip);
        expect(error.message).toContain("no branch to save to");
        expect(yield* fs.exists(worktree)).toBe(true);
      }),
    ),
  );

  it.live("refuses while a terminal is open in the worktree", () =>
    run(
      Effect.gen(function* () {
        const { service, fs, worktree, openTerminal } = yield* fixture;
        yield* openTerminal(worktree);
        const error = yield* service
          .removeWorktree({ path: worktree, allowUncommittedFiles: 0 })
          .pipe(Effect.flip);
        expect(error.message).toBe("A terminal is open in this worktree.");
        expect(yield* fs.exists(worktree)).toBe(true);
      }),
    ),
  );

  it.live("refuses a linked worktree deeper than the listed layout", () =>
    run(
      Effect.gen(function* () {
        const { service, fs, repo, command, worktree } = yield* fixture;
        const deep = `${worktree}/nested/deep`;
        yield* fs.makeDirectory(`${worktree}/nested`, { recursive: true });
        yield* command(repo, ["worktree", "add", "-b", "deep", deep]);
        const error = yield* service
          .removeWorktree({ path: deep, allowUncommittedFiles: 0 })
          .pipe(Effect.flip);
        expect(error.message).toContain("not a linked git worktree");
        expect(yield* fs.exists(deep)).toBe(true);
      }),
    ),
  );
});
