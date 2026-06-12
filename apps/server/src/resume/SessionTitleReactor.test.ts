import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../persistence/Layers/ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { handleMetaUpdated, type RenameSessionWrite } from "./SessionTitleReactor.ts";

// A recording fake for the injected write-through. Records every call so tests
// can assert it fired (and with what) — or, crucially, that it did NOT fire.
interface RecordedRename {
  readonly sessionId: string;
  readonly title: string;
  readonly dir?: string | undefined;
}
const makeRecorder = () => {
  const calls: Array<RecordedRename> = [];
  const renameSession: RenameSessionWrite = (sessionId, title, options) =>
    Effect.sync(() => {
      calls.push({ sessionId, title, dir: options?.dir });
    });
  return { calls, renameSession };
};

const WORKSPACE_ROOT = "/workspace/demo";
const PROJECT_ID = ProjectId.make("project-1");

// Stub of ProjectionSnapshotQuery: the two methods the reactor touches resolve
// real values for the resolvable thread; every other method dies (never called
// in these tests). Mirrors the full-object stub pattern in
// CheckpointDiffQuery.test.ts so we don't stand up the real Live layer.
const stubSnapshotQuery = (resolvableThreadId: ThreadId) =>
  Layer.succeed(ProjectionSnapshotQuery, {
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
    getThreadDetailById: () => Effect.die("unused"),
    getProjectShellById: (projectId: ProjectId) =>
      Effect.succeed(
        projectId === PROJECT_ID
          ? Option.some({ projectId, workspaceRoot: WORKSPACE_ROOT } as never)
          : Option.none(),
      ),
    getThreadShellById: (threadId: ThreadId) =>
      Effect.succeed(
        threadId === resolvableThreadId
          ? Option.some({ id: threadId, projectId: PROJECT_ID } as never)
          : Option.none(),
      ),
  });

function makeBaseLayers<E, R>(
  persistenceLayer: Layer.Layer<SqlClient.SqlClient, E, R>,
  resolvableThreadId: ThreadId,
) {
  const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
    Layer.provide(persistenceLayer),
  );
  return Layer.mergeAll(
    runtimeRepositoryLayer,
    ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer)),
    stubSnapshotQuery(resolvableThreadId),
    NodeServices.layer,
  );
}

const CLAUDE_SESSION_ID = "00a5c392-f7f3-4e01-ad14-1bba7c69d789";
const INSTANCE_ID = ProviderInstanceId.make("claude-default");

// Seed a Claude binding whose resume cursor carries a session id.
const seedClaudeBinding = (threadId: ThreadId, resumeCursor: unknown) =>
  Effect.gen(function* () {
    const directory = yield* ProviderSessionDirectory;
    yield* directory.upsert({
      threadId,
      provider: "claudeAgent" as never,
      providerInstanceId: INSTANCE_ID,
      status: "stopped",
      runtimeMode: "full-access",
      resumeCursor,
    });
  });

it.layer(makeBaseLayers(SqlitePersistenceMemory, ThreadId.make("thread-fires")))(
  "SessionTitleReactor",
  (it) => {
    it.effect(
      "fires renameSession for a user rename of a Claude thread with a resume cursor",
      () =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("thread-fires");
          yield* seedClaudeBinding(threadId, { resume: CLAUDE_SESSION_ID });

          const { calls, renameSession } = makeRecorder();
          yield* handleMetaUpdated(
            { threadId, title: "Renamed by user", titleSource: "user" },
            { renameSession },
          );
          // The write-through is forked; let the forked fiber run.
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;

          assert.equal(calls.length, 1);
          assert.deepEqual(calls[0], {
            sessionId: CLAUDE_SESSION_ID,
            title: "Renamed by user",
            dir: WORKSPACE_ROOT,
          });
        }),
    );

    it.effect("falls back to the cursor's sessionId when there is no resume", () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-fires");
        yield* seedClaudeBinding(threadId, { sessionId: CLAUDE_SESSION_ID });

        const { calls, renameSession } = makeRecorder();
        yield* handleMetaUpdated(
          { threadId, title: "Renamed", titleSource: "user" },
          { renameSession },
        );
        yield* Effect.yieldNow;
          yield* Effect.yieldNow;

        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.sessionId, CLAUDE_SESSION_ID);
      }));

    it.effect("does NOT fire for an auto title", () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-fires");
        yield* seedClaudeBinding(threadId, { resume: CLAUDE_SESSION_ID });

        const { calls, renameSession } = makeRecorder();
        yield* handleMetaUpdated(
          { threadId, title: "Auto title", titleSource: "auto" },
          { renameSession },
        );
        yield* Effect.yieldNow;
          yield* Effect.yieldNow;

        assert.equal(calls.length, 0);
      }));

    it.effect("does NOT fire when titleSource is absent", () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-fires");
        yield* seedClaudeBinding(threadId, { resume: CLAUDE_SESSION_ID });

        const { calls, renameSession } = makeRecorder();
        yield* handleMetaUpdated(
          { threadId, title: "Branch rename" },
          { renameSession },
        );
        yield* Effect.yieldNow;
          yield* Effect.yieldNow;

        assert.equal(calls.length, 0);
      }));

    it.effect("does NOT fire when there is no binding", () =>
      Effect.gen(function* () {
        // A thread id that is NEVER seeded -> getBinding returns Option.none.
        // (The in-memory directory is shared across the it.layer block, so the
        // shared "thread-fires" id carries a binding from earlier tests.)
        const threadId = ThreadId.make("thread-no-binding");

        const { calls, renameSession } = makeRecorder();
        yield* handleMetaUpdated(
          { threadId, title: "Renamed", titleSource: "user" },
          { renameSession },
        );
        yield* Effect.yieldNow;
          yield* Effect.yieldNow;

        assert.equal(calls.length, 0);
      }));

    it.effect("does NOT fire for a non-Claude provider binding", () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-fires");
        // Seed a Codex binding carrying a cursor; must be skipped on provider.
        const directory = yield* ProviderSessionDirectory;
        yield* directory.upsert({
          threadId,
          provider: "codex" as never,
          providerInstanceId: INSTANCE_ID,
          status: "stopped",
          runtimeMode: "full-access",
          resumeCursor: { resume: CLAUDE_SESSION_ID },
        });

        const { calls, renameSession } = makeRecorder();
        yield* handleMetaUpdated(
          { threadId, title: "Renamed", titleSource: "user" },
          { renameSession },
        );
        yield* Effect.yieldNow;
          yield* Effect.yieldNow;

        assert.equal(calls.length, 0);
      }));

    it.effect("does NOT fire when the cursor has no resume/sessionId", () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-fires");
        yield* seedClaudeBinding(threadId, { threadId });

        const { calls, renameSession } = makeRecorder();
        yield* handleMetaUpdated(
          { threadId, title: "Renamed", titleSource: "user" },
          { renameSession },
        );
        yield* Effect.yieldNow;
          yield* Effect.yieldNow;

        assert.equal(calls.length, 0);
      }));

    it.effect("omits dir when the thread's workspace root cannot be resolved", () =>
      Effect.gen(function* () {
        // This thread id is NOT the stub's resolvable id, so dir resolution
        // yields undefined — the rename must still fire, just without dir.
        const threadId = ThreadId.make("thread-no-dir");
        yield* seedClaudeBinding(threadId, { resume: CLAUDE_SESSION_ID });

        const { calls, renameSession } = makeRecorder();
        yield* handleMetaUpdated(
          { threadId, title: "Renamed", titleSource: "user" },
          { renameSession },
        );
        yield* Effect.yieldNow;
          yield* Effect.yieldNow;

        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.dir, undefined);
      }));

    it.effect("still fires (dir omitted) when dir resolution ERRORS", () =>
      Effect.gen(function* () {
        // resolveThreadDir must degrade an error to undefined, never block the
        // rename. Override the snapshot query with one whose getThreadShellById
        // FAILS (not dies — Effect.catch only catches failures).
        const threadId = ThreadId.make("thread-fires");
        yield* seedClaudeBinding(threadId, { resume: CLAUDE_SESSION_ID });

        const failingSnapshotQuery: ProjectionSnapshotQuery["Service"] = {
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
          getThreadDetailById: () => Effect.die("unused"),
          getProjectShellById: () => Effect.die("unused"),
          getThreadShellById: () =>
            Effect.fail(
              new PersistenceSqlError({
                operation: "getThreadShellById",
                detail: "boom",
              }),
            ),
        };

        const { calls, renameSession } = makeRecorder();
        yield* handleMetaUpdated(
          { threadId, title: "Renamed", titleSource: "user" },
          { renameSession },
        ).pipe(Effect.provideService(ProjectionSnapshotQuery, failingSnapshotQuery));
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.dir, undefined);
      }));
  },
);
