// @effect-diagnostics nodeBuiltinImport:off - Effect has no lstat; symlinks must not be followed while measuring.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  GitCommandError,
  OrchestrationV2ProviderSessionJson,
  StorageOverviewError,
  type StorageOverview as StorageOverviewResult,
  type StorageOverviewCategory,
  type StorageOverviewWorktree,
  type StorageRemoveWorktreeInput,
  type StorageRemoveWorktreeResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as Settings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { removeLinkedWorktree } from "../vcs/worktreeRemoval.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { isFilesystemRoot, managedWorktreesDirectories } from "../worktreesDirectory.ts";

const CACHE_TTL_MS = 60_000;
const MEASURE_CONCURRENCY = 4;
const MAX_WALK_ENTRIES = 2_000_000;
const STAT_BATCH = 256;

const decodeSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJson),
);

export class StorageOverview extends Context.Service<
  StorageOverview,
  {
    readonly get: (input: {
      readonly refresh?: boolean;
    }) => Effect.Effect<StorageOverviewResult, StorageOverviewError>;
    readonly removeWorktree: (
      input: StorageRemoveWorktreeInput,
    ) => Effect.Effect<StorageRemoveWorktreeResult, StorageOverviewError>;
  }
>()("t3/storageOverview/StorageOverview") {}

const isStorageOverviewError = Schema.is(StorageOverviewError);
const isGitCommandError = Schema.is(GitCommandError);

const fail = (message: string) => new StorageOverviewError({ message });

const toOverviewError = (error: unknown): StorageOverviewError =>
  isStorageOverviewError(error)
    ? error
    : isGitCommandError(error)
      ? fail(error.detail.split(/\r?\n/).find((line) => line.trim() !== "") ?? error.message)
      : fail(error instanceof Error ? error.message : String(error));

interface WalkResult {
  readonly bytes: number;
  readonly complete: boolean;
}

const allocatedBytes = (stat: { readonly blocks?: number; readonly size: number }) =>
  typeof stat.blocks === "number" ? stat.blocks * 512 : stat.size;

/**
 * Sums allocated bytes under `root` with lstat semantics: symlinks are never
 * followed. `skipSharedLinks` ignores files with several hard links, since
 * deleting them frees nothing. The root itself may be a symlink (a linked home).
 */
async function walkBytes(
  root: string,
  options: {
    readonly skip: ReadonlySet<string>;
    readonly skipSharedLinks: boolean;
    readonly signal: AbortSignal;
  },
): Promise<WalkResult> {
  const pending = [root];
  let entries = 0;
  let bytes = 0;
  while (pending.length > 0) {
    if (options.signal.aborted) {
      return { bytes, complete: false };
    }
    const directory = pending.pop()!;
    let names: string[];
    try {
      names = await NodeFSP.readdir(directory);
    } catch {
      continue;
    }
    entries += names.length;
    if (entries > MAX_WALK_ENTRIES) return { bytes, complete: false };
    for (let index = 0; index < names.length; index += STAT_BATCH) {
      const batch = names.slice(index, index + STAT_BATCH);
      const stats = await Promise.all(
        batch.map(async (name) => {
          const target = NodePath.join(directory, name);
          if (options.skip.has(target)) return null;
          try {
            return { target, stat: await NodeFSP.lstat(target) };
          } catch {
            return null;
          }
        }),
      );
      for (const item of stats) {
        if (item === null) continue;
        if (item.stat.isDirectory()) {
          pending.push(item.target);
        } else if (item.stat.isFile()) {
          if (options.skipSharedLinks && item.stat.nlink > 1) continue;
          bytes += allocatedBytes(item.stat);
        }
      }
    }
  }
  return { bytes, complete: true };
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* Settings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const sql = yield* SqlClient.SqlClient;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const isWindows = yield* HostProcess.isWindows;
  const home = yield* HostProcess.HomeDirectory;

  const pathKey = (target: string) => {
    const resolved = path.resolve(target);
    return isWindows ? resolved.toLowerCase() : resolved;
  };
  const inside = (root: string, target: string) => {
    const relative = path.relative(pathKey(root), pathKey(target));
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };

  const lstat = (target: string) =>
    Effect.tryPromise({ try: () => NodeFSP.lstat(target), catch: toOverviewError }).pipe(
      Effect.option,
    );
  const isLinkedWorktreeDirectory = Effect.fn("StorageOverview.isLinkedWorktreeDirectory")(
    function* (target: string) {
      const self = yield* lstat(target);
      if (self._tag === "None" || !self.value.isDirectory()) return false;
      const dotGit = yield* lstat(path.join(target, ".git"));
      return dotGit._tag === "Some" && dotGit.value.isFile();
    },
  );

  const managedRoots = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(Effect.mapError(toOverviewError));
    const roots: string[] = [];
    for (const directory of managedWorktreesDirectories(
      settings,
      config.worktreesDir,
      path,
      home,
    )) {
      const root = yield* fs.realPath(directory).pipe(Effect.option);
      if (
        root._tag === "Some" &&
        !isFilesystemRoot(root.value, path) &&
        !roots.includes(root.value)
      )
        roots.push(root.value);
    }
    return roots;
  });

  /** Worktrees sit at <root>/<name> or <root>/<project>/<name>; a worktree's `.git` is a file. */
  const discoverWorktrees = Effect.fn("StorageOverview.discoverWorktrees")(function* (
    roots: ReadonlyArray<string>,
  ) {
    const found: Array<{ path: string; nestedProject: string | null }> = [];
    const seen = new Set<string>();
    for (const root of roots) {
      const children = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
      for (const name of children) {
        const first = path.join(root, name);
        if (yield* isLinkedWorktreeDirectory(first)) {
          if (!seen.has(pathKey(first))) {
            seen.add(pathKey(first));
            found.push({ path: first, nestedProject: null });
          }
          continue;
        }
        const firstStat = yield* lstat(first);
        if (firstStat._tag === "None" || !firstStat.value.isDirectory()) continue;
        const grandchildren = yield* fs.readDirectory(first).pipe(Effect.orElseSucceed(() => []));
        for (const grandchild of grandchildren) {
          const second = path.join(first, grandchild);
          if (seen.has(pathKey(second)) || !(yield* isLinkedWorktreeDirectory(second))) continue;
          seen.add(pathKey(second));
          found.push({ path: second, nestedProject: name });
        }
      }
    }
    return found;
  });

  const measureDirectory = (
    root: string,
    skip: ReadonlySet<string>,
    skipSharedLinks: boolean,
  ): Effect.Effect<WalkResult> =>
    Effect.tryPromise({
      try: (signal) => walkBytes(root, { skip, skipSharedLinks, signal }),
      catch: toOverviewError,
    }).pipe(
      Effect.timeout("30 seconds"),
      Effect.orElseSucceed((): WalkResult => ({ bytes: 0, complete: false })),
    );

  const measureWorktree = (worktreePath: string) =>
    measureDirectory(worktreePath, new Set(), true).pipe(
      Effect.map((result) => (result.complete ? result.bytes : null)),
    );

  const fileBytes = (target: string) =>
    lstat(target).pipe(
      Effect.map((stat) =>
        stat._tag === "Some" && stat.value.isFile() ? allocatedBytes(stat.value) : 0,
      ),
    );

  const gitLines = (cwd: string, args: ReadonlyArray<string>) =>
    git
      .execute({
        operation: "StorageOverview.git",
        cwd,
        args,
        allowNonZeroExit: true,
        timeoutMs: 20_000,
        maxOutputBytes: 4 * 1024 * 1024,
      })
      .pipe(
        Effect.map((result) =>
          result.exitCode === 0 ? result.stdout.split(/\r?\n/).filter((line) => line !== "") : null,
        ),
        Effect.orElseSucceed(() => null),
      );

  const readContext = Effect.gen(function* () {
    const snapshot = yield* projections.getShellSnapshot().pipe(NodeSqliteClient.readOnly);
    const projects = yield* projectStore.listShells();
    return {
      projects,
      threads: [
        ...snapshot.threads.map((thread) => ({ thread, archived: false })),
        ...snapshot.archivedThreads.map((thread) => ({ thread, archived: true })),
      ],
    };
  });

  let cache: { readonly at: number; readonly value: StorageOverviewResult } | null = null;
  const measuring = Semaphore.makeUnsafe(1);

  const measure = Effect.gen(function* () {
    const roots = yield* managedRoots;
    const { projects, threads } = yield* readContext;
    const discovered = yield* discoverWorktrees(roots);

    const threadsByPath = new Map<string, Array<(typeof threads)[number]>>();
    for (const entry of threads) {
      const worktreePath = entry.thread.worktreePath;
      if (worktreePath === null) continue;
      const resolved = path.resolve(worktreePath);
      const real = yield* fs.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved));
      for (const key of new Set([pathKey(resolved), pathKey(real)])) {
        const list = threadsByPath.get(key) ?? [];
        if (!list.includes(entry)) list.push(entry);
        threadsByPath.set(key, list);
      }
    }

    const worktrees = yield* Effect.forEach(
      discovered,
      (item) =>
        Effect.gen(function* () {
          const owners = threadsByPath.get(pathKey(item.path)) ?? [];
          const project = projects.find((candidate) =>
            owners.some((owner) => owner.thread.projectId === candidate.id),
          );
          const [bytes, status, branchLines] = yield* Effect.all(
            [
              measureWorktree(item.path),
              gitLines(item.path, [
                "-c",
                "status.showUntrackedFiles=normal",
                "status",
                "--porcelain",
              ]),
              gitLines(item.path, ["rev-parse", "--abbrev-ref", "HEAD"]),
            ],
            { concurrency: "unbounded" },
          );
          const branch = branchLines?.[0]?.trim() ?? null;
          return {
            path: item.path,
            projectRoot: project?.workspaceRoot ?? null,
            projectName:
              project !== undefined
                ? path.basename(project.workspaceRoot) || project.title
                : (item.nestedProject ?? path.basename(item.path)),
            branch: branch === null || branch === "" || branch === "HEAD" ? null : branch,
            bytes,
            uncommittedFiles: status?.length ?? 0,
            threads: owners.map(({ thread, archived }) => ({
              threadId: thread.id,
              title: thread.title,
              archived,
            })),
          } satisfies StorageOverviewWorktree;
        }),
      { concurrency: MEASURE_CONCURRENCY },
    );
    worktrees.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));

    const dbFiles = [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`];
    const runtimeDir = path.join(config.baseDir, "runtime");
    const skip = new Set<string>([
      config.worktreesDir,
      config.logsDir,
      runtimeDir,
      ...dbFiles,
      ...roots,
    ]);
    const [databaseBytes, logs, runtime, other] = yield* Effect.all([
      Effect.forEach(dbFiles, fileBytes).pipe(
        Effect.map((sizes) => sizes.reduce((sum, size) => sum + size, 0)),
      ),
      measureDirectory(config.logsDir, new Set(), false),
      measureDirectory(runtimeDir, new Set(), false),
      measureDirectory(config.baseDir, skip, false),
    ]);

    const categories: StorageOverviewCategory[] = [
      {
        key: "worktrees" as const,
        bytes: worktrees.reduce((sum, worktree) => sum + (worktree.bytes ?? 0), 0),
      },
      { key: "runtime" as const, bytes: runtime.bytes },
      { key: "database" as const, bytes: databaseBytes },
      { key: "logs" as const, bytes: logs.bytes },
      { key: "other" as const, bytes: other.bytes },
    ]
      .map((category) => ({ ...category, bytes: Math.round(category.bytes) }))
      .filter((category) => category.bytes > 0);

    return {
      measuredAt: DateTime.formatIso(yield* DateTime.now),
      totalBytes: categories.reduce((sum, category) => sum + category.bytes, 0),
      categories,
      worktrees,
    } satisfies StorageOverviewResult;
  });

  const get = Effect.fn("StorageOverview.get")(function* (input: { readonly refresh?: boolean }) {
    const requestedAt = yield* Clock.currentTimeMillis;
    return yield* measuring.withPermit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        // A measurement that finished while this call waited is as fresh as one it would start.
        if (
          cache !== null &&
          (cache.at >= requestedAt || (input.refresh !== true && now - cache.at < CACHE_TTL_MS))
        )
          return cache.value;
        const value = yield* measure;
        cache = { at: yield* Clock.currentTimeMillis, value };
        return value;
      }),
    );
  }, Effect.mapError(toOverviewError));

  const containsProjectRoot = Effect.fn("StorageOverview.containsProjectRoot")(function* (
    worktreePath: string,
    projects: ReadonlyArray<{ readonly workspaceRoot: string }>,
  ) {
    {
      for (const project of projects) {
        const projectPath = path.resolve(project.workspaceRoot);
        if (pathKey(projectPath) === pathKey(worktreePath) || inside(worktreePath, projectPath))
          return true;
        const real = yield* fs.realPath(projectPath).pipe(Effect.orElseSucceed(() => projectPath));
        if (pathKey(real) === pathKey(worktreePath) || inside(worktreePath, real)) return true;
      }
      return false;
    }
  });

  const liveSessionInside = Effect.fn("StorageOverview.liveSessionInside")(function* (
    worktreePath: string,
  ) {
    {
      const rows = yield* sql<{ payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_provider_sessions
        WHERE status != 'stopped'
      `.pipe(NodeSqliteClient.readOnly);
      for (const row of rows) {
        const session = yield* decodeSession(row.payload_json);
        const cwd = path.resolve(session.cwd);
        if (
          (pathKey(cwd) === pathKey(worktreePath) || inside(worktreePath, cwd)) &&
          (yield* providerSessions.isLive(session.id))
        )
          return true;
      }
      return false;
    }
  });

  const removeWorktree = Effect.fn("StorageOverview.removeWorktree")(function* (
    input: StorageRemoveWorktreeInput,
  ) {
    if (!path.isAbsolute(input.path)) return yield* fail("That folder is not a managed worktree.");
    const requested = path.resolve(input.path);
    const worktreePath = yield* fs
      .realPath(requested)
      .pipe(Effect.mapError(() => fail("That folder no longer exists.")));
    const self = yield* lstat(requested);
    if (
      self._tag === "None" ||
      self.value.isSymbolicLink() ||
      pathKey(worktreePath) !== pathKey(requested)
    )
      return yield* fail("That folder is not a managed worktree.");
    const roots = yield* managedRoots;
    if (!roots.some((root) => inside(root, worktreePath)))
      return yield* fail("That folder is outside the managed worktree folders.");
    if (!(yield* isLinkedWorktreeDirectory(worktreePath)))
      return yield* fail("That folder is not a linked git worktree.");

    return yield* withWorkspaceLease(
      worktreePath,
      Effect.gen(function* () {
        const allProjects = yield* projectStore.list({ includeDeleted: true });
        if (yield* containsProjectRoot(worktreePath, allProjects))
          return yield* fail("A project lives inside this folder.");
        if (yield* liveSessionInside(worktreePath))
          return yield* fail("A provider session is still open in this worktree.");

        const { projects, threads } = yield* readContext;
        let repository: string | null = null;
        for (const { thread } of threads) {
          if (thread.worktreePath === null) continue;
          const resolved = path.resolve(thread.worktreePath);
          const real = yield* fs.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved));
          if (
            pathKey(resolved) !== pathKey(worktreePath) &&
            pathKey(real) !== pathKey(worktreePath)
          )
            continue;
          const project = projects.find((candidate) => candidate.id === thread.projectId);
          if (
            project !== undefined &&
            (yield* fs.exists(project.workspaceRoot).pipe(Effect.orElseSucceed(() => false)))
          ) {
            repository = project.workspaceRoot;
            break;
          }
        }
        if (repository === null) {
          const common = yield* gitLines(worktreePath, ["rev-parse", "--git-common-dir"]);
          const commonDir = common?.[0];
          if (commonDir !== undefined) {
            const candidate = path.dirname(path.resolve(worktreePath, commonDir.trim()));
            if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false)))
              repository = candidate;
          }
        }
        if (repository === null) return yield* fail("The repository for this worktree is gone.");
        const repositoryCwd = repository;

        const knownBytes =
          cache?.value.worktrees.find(
            (worktree) => pathKey(worktree.path) === pathKey(worktreePath),
          )?.bytes ?? null;

        yield* removeLinkedWorktree({
          operation: "StorageOverview.removeWorktree",
          cwd: repositoryCwd,
          worktreePath,
          force: input.discardChanges,
          execute: git.execute,
          run: Effect.fn("StorageOverview.gitWorktreeRemove")(function* (
            args: ReadonlyArray<string>,
          ) {
            const result = yield* git.execute({
              operation: "StorageOverview.removeWorktree",
              cwd: repositoryCwd,
              args,
              allowNonZeroExit: true,
              timeoutMs: 300_000,
            });
            if (result.exitCode !== 0)
              return yield* new GitCommandError({
                operation: "StorageOverview.removeWorktree",
                command: "git worktree remove",
                cwd: repositoryCwd,
                detail: result.stderr.trim().split(/\r?\n/)[0]?.slice(0, 1000) || "command failed",
              });
          }),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        cache = null;
        yield* gitManager.invalidateStatus(repositoryCwd);
        // Thread rows keep their branch and path so the next message rebuilds the checkout.
        yield* Effect.logInfo("storage overview removed worktree", { worktreePath });
        return { bytesFreed: knownBytes };
      }),
    );
  }, Effect.mapError(toOverviewError));

  return StorageOverview.of({ get, removeWorktree });
});

export const layer = Layer.effect(StorageOverview, make);
