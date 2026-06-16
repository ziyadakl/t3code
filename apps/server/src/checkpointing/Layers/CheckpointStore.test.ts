// @effect-diagnostics nodeBuiltinImport:off
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import { describe, expect } from "vite-plus/test";

import { checkpointRefForThreadTurn } from "../Utils.ts";
import { CheckpointStoreLive } from "./CheckpointStore.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import type { VcsError } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import { ThreadId } from "@t3tools/contracts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-checkpoint-store-test-",
});
const VcsProcessTestLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const VcsDriverTestLayer = VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcessTestLayer));
const CheckpointStoreTestLayer = CheckpointStoreLive.pipe(
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(NodeServices.layer),
);
const TestLayer = CheckpointStoreTestLayer.pipe(
  Layer.provideMerge(VcsProcessTestLayer),
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

function makeTmpDir(
  prefix = "checkpoint-store-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function writeTextFile(
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, contents);
  });
}

function git(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, VcsError, VcsProcess.VcsProcess> {
  return Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const result = yield* process.run({
      operation: "CheckpointStore.test.git",
      command: "git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });
}

function initRepoWithCommit(
  cwd: string,
): Effect.Effect<
  void,
  VcsError | PlatformError.PlatformError,
  VcsProcess.VcsProcess | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    yield* git(cwd, ["init"]);
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(path.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });
}

function buildLargeText(lineCount = 5_000): string {
  return Array.from({ length: lineCount }, (_, index) => `line ${String(index).padStart(5, "0")}`)
    .join("\n")
    .concat("\n");
}

it.layer(TestLayer)("CheckpointStoreLive", (it) => {
  describe("diffCheckpoints", () => {
    it.effect("returns full oversized checkpoint diffs without truncation", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(path.join(tmp, "README.md"), buildLargeText());
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        });

        expect(diff).toContain("diff --git");
        expect(diff).not.toContain("[truncated]");
        expect(diff).toContain("+line 04999");
      }),
    );

    it.effect("can hide indentation churn when changes wrap existing lines", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-whitespace");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        const componentPath = path.join(tmp, "Component.tsx");
        yield* writeTextFile(
          componentPath,
          [
            "export function View() {",
            "  return (",
            "    <section>",
            "      <h1>Title</h1>",
            "      <p>Body</p>",
            "    </section>",
            "  );",
            "}",
            "",
          ].join("\n"),
        );
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(
          componentPath,
          [
            "export function View() {",
            "  return (",
            "    <section>",
            "      {isReady ? (",
            "        <div>",
            "          <h1>Title</h1>",
            "          <p>Body</p>",
            "        </div>",
            "      ) : null}",
            "    </section>",
            "  );",
            "}",
            "",
          ].join("\n"),
        );
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const normalDiff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
        });
        const whitespaceIgnoredDiff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        });

        expect(normalDiff).toContain("diff --git");
        expect(normalDiff).toContain("-      <h1>Title</h1>");
        expect(normalDiff).toContain("+          <h1>Title</h1>");
        expect(whitespaceIgnoredDiff).toContain("diff --git");
        expect(whitespaceIgnoredDiff).toContain("+      {isReady ? (");
        expect(whitespaceIgnoredDiff).toContain("+        <div>");
        expect(whitespaceIgnoredDiff).not.toContain("-      <h1>Title</h1>");
        expect(whitespaceIgnoredDiff).not.toContain("+          <h1>Title</h1>");
      }),
    );
  });

  describe("restoreCheckpoint", () => {
    it.effect(
      "scoped restore reverts only the agent's files and never touches the user's files",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          const checkpointStore = yield* CheckpointStore;
          const threadId = ThreadId.make("thread-restore-scoped");
          const baseline = checkpointRefForThreadTurn(threadId, 0);

          // Baseline captured into the checkpoint.
          yield* writeTextFile(path.join(tmp, "agent.ts"), "agent-v1\n");
          yield* writeTextFile(path.join(tmp, "user.ts"), "user-v1\n");
          yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: baseline });

          // The turn: the agent edits agent.ts; meanwhile the user hand-edits
          // user.ts and creates a brand-new untracked file.
          yield* writeTextFile(path.join(tmp, "agent.ts"), "agent-v2\n");
          yield* writeTextFile(path.join(tmp, "user.ts"), "user-v2\n");
          yield* writeTextFile(path.join(tmp, "user-new.ts"), "user-new\n");

          const restored = yield* checkpointStore.restoreCheckpoint({
            cwd: tmp,
            checkpointRef: baseline,
            paths: ["agent.ts"],
          });

          expect(restored).toBe(true);
          // Agent's edit reverted to the checkpoint.
          expect(yield* fileSystem.readFileString(path.join(tmp, "agent.ts"))).toBe("agent-v1\n");
          // User's concurrent hand-edit preserved (not in the agent edit set).
          expect(yield* fileSystem.readFileString(path.join(tmp, "user.ts"))).toBe("user-v2\n");
          // User's new untracked file is NOT deleted (the old `clean -fd` bug).
          expect(yield* fileSystem.exists(path.join(tmp, "user-new.ts"))).toBe(true);
        }),
    );

    it.effect("scoped restore removes an agent-created file but keeps the user's new files", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-restore-created");
        const baseline = checkpointRefForThreadTurn(threadId, 0);

        // Baseline: neither file exists yet.
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: baseline });

        // The turn: the agent creates created.ts; the user creates their own file.
        yield* writeTextFile(path.join(tmp, "created.ts"), "created\n");
        yield* writeTextFile(path.join(tmp, "user-own.ts"), "mine\n");

        const restored = yield* checkpointStore.restoreCheckpoint({
          cwd: tmp,
          checkpointRef: baseline,
          paths: ["created.ts"],
        });

        expect(restored).toBe(true);
        // Agent-created file is undone (absent in the checkpoint → removed).
        expect(yield* fileSystem.exists(path.join(tmp, "created.ts"))).toBe(false);
        // The user's own new file is untouched.
        expect(yield* fileSystem.exists(path.join(tmp, "user-own.ts"))).toBe(true);
      }),
    );

    it.effect("whole-tree restore (no paths) still reverts everything and removes untracked", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-restore-wholetree");
        const baseline = checkpointRefForThreadTurn(threadId, 0);

        yield* writeTextFile(path.join(tmp, "tracked.ts"), "v1\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: baseline });
        yield* writeTextFile(path.join(tmp, "tracked.ts"), "v2\n");
        yield* writeTextFile(path.join(tmp, "untracked.ts"), "stray\n");

        // No `paths` → legacy whole-tree behavior, unchanged.
        yield* checkpointStore.restoreCheckpoint({ cwd: tmp, checkpointRef: baseline });

        expect(yield* fileSystem.readFileString(path.join(tmp, "tracked.ts"))).toBe("v1\n");
        expect(yield* fileSystem.exists(path.join(tmp, "untracked.ts"))).toBe(false);
      }),
    );
  });
});
