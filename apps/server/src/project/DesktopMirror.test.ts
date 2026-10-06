import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as AgentSessionResume from "./AgentSessionResume.ts";
import { encodeClaudeProjectDir, type DesktopSession } from "./ClaudeSessionSources.ts";
import * as DesktopMirror from "./DesktopMirror.ts";
import * as ProjectService from "./ProjectService.ts";

const ids = {
  shared: "11111111-1111-4111-8111-111111111111",
  sharedOld: "22222222-2222-4222-8222-222222222222",
  archived: "33333333-3333-4333-8333-333333333333",
  elsewhere: "44444444-4444-4444-8444-444444444444",
  caseFolded: "55555555-5555-4555-8555-555555555555",
};

const card = (fields: Record<string, unknown>) => JSON.stringify(fields);

const transcript = (sessionId: string, cwd: string) =>
  JSON.stringify({
    type: "user",
    cwd,
    sessionId,
    uuid: `${sessionId}-u`,
    timestamp: "2026-10-01T10:00:00.000Z",
    message: { role: "user", content: "Hello" },
  }) + "\n";

/**
 * Two accounts holding the same session (renamed in the newer copy), an
 * archived session, one whose folder is on another machine, and one whose
 * folder an existing project spells in another case.
 */
const writeFixtures = Effect.fn("writeFixtures")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const app = path.join(root, "work", "app");
  const other = path.join(root, "work", "Other");
  const claudeHome = path.join(root, "claude-home");
  const store = path.join(root, "desktop-store");
  yield* fs.makeDirectory(app, { recursive: true });
  yield* fs.makeDirectory(other, { recursive: true });

  const write = (filePath: string, contents: string, mtimeSeconds: number) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fs.writeFileString(filePath, contents);
      yield* fs.utimes(filePath, mtimeSeconds, mtimeSeconds);
    });
  const writeTranscript = (cliSessionId: string, cwd: string) =>
    write(
      path.join(claudeHome, "projects", encodeClaudeProjectDir(cwd), `${cliSessionId}.jsonl`),
      transcript(cliSessionId, cwd),
      1_000,
    );

  yield* write(
    path.join(store, "acct-a", "org-1", "local_shared.json"),
    card({
      sessionId: "local_shared",
      cliSessionId: ids.sharedOld,
      cwd: app,
      title: "Old title",
      lastActivityAt: 1_000,
    }),
    1_000,
  );
  yield* write(
    path.join(store, "acct-b", "org-2", "backlog", "local_shared.json"),
    card({
      sessionId: "local_shared",
      cliSessionId: ids.shared,
      cwd: app,
      title: "Fix the login page",
      lastActivityAt: 3_000,
    }),
    2_000,
  );
  yield* writeTranscript(ids.shared, app);
  yield* write(
    path.join(store, "acct-a", "org-1", "local_archived.json"),
    card({
      sessionId: "local_archived",
      cliSessionId: ids.archived,
      cwd: app,
      title: "Done already",
      isArchived: true,
      lastActivityAt: 2_000,
    }),
    1_000,
  );
  yield* writeTranscript(ids.archived, app);
  yield* write(
    path.join(store, "acct-a", "org-1", "local_elsewhere.json"),
    card({
      sessionId: "local_elsewhere",
      cliSessionId: ids.elsewhere,
      cwd: "/home/someone-else/project",
      title: "Runs on the other machine",
      lastActivityAt: 4_000,
    }),
    1_000,
  );
  yield* write(
    path.join(store, "acct-a", "org-1", "local_case.json"),
    card({
      sessionId: "local_case",
      cliSessionId: ids.caseFolded,
      cwd: path.join(root, "work", "Other", ".claude", "worktrees", "calm-owl"),
      originCwd: other,
      title: "Case folded",
      lastActivityAt: 5_000,
    }),
    1_000,
  );
  yield* writeTranscript(ids.caseFolded, other);
  return { app, other, claudeHome, store };
});

/** In-memory stand-ins for the project store, the importer and the orchestrator. */
function makeFakes(existingProjects: Array<{ id: ProjectId; workspaceRoot: string }>) {
  const projects = [...existingProjects];
  const threads = new Map<ThreadId, OrchestrationV2AppThread>();
  const bootstrapped: string[] = [];
  const continued: Array<{ projectId: ProjectId; providerSessionId: string; title: string }> = [];
  const refreshed: ThreadId[] = [];
  const commands: OrchestrationV2ServerCommand[] = [];

  const layer = Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({
      snapshot: Effect.sync(() => ({
        projects: projects.map((project) => ({ ...project, deletedAt: null }) as never),
        updatedAt: "2026-10-07T00:00:00.000Z",
      })),
      bootstrap: (input) =>
        Effect.sync(() => {
          bootstrapped.push(input.workspaceRoot);
          const project = { id: input.projectId, workspaceRoot: input.workspaceRoot };
          projects.push(project);
          return { project: project as never, created: true };
        }),
      getById: (projectId) =>
        Effect.succeed(
          Option.fromUndefinedOr(projects.find((project) => project.id === projectId) as never),
        ),
    }),
    Layer.mock(AgentSessionResume.AgentSessionResume)({
      continueSession: (input) =>
        Effect.sync(() => {
          const threadId = ThreadId.make(`import:claudeAgent:${input.session.providerSessionId}`);
          continued.push({
            projectId: input.project.id,
            providerSessionId: input.session.providerSessionId,
            title: input.session.title,
          });
          threads.set(threadId, {
            id: threadId,
            projectId: input.project.id,
            title: input.session.title,
            archivedAt: null,
            deletedAt: null,
            settledOverride: "active",
          } as never);
          return { threadId, created: true };
        }),
      refreshSession: (input) => Effect.sync(() => (refreshed.push(input.threadId), 0)),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadRecords: (threadId) => {
        const thread = threads.get(threadId);
        return thread === undefined
          ? Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId }))
          : Effect.succeed({ thread } as never);
      },
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          if (!("threadId" in command)) return {} as never;
          const thread = threads.get(command.threadId);
          if (thread === undefined) return {} as never;
          if (command.type === "thread.archive") {
            threads.set(thread.id, { ...thread, archivedAt: "2026-10-07T00:00:00.000Z" as never });
          }
          if (command.type === "thread.metadata.update" && command.title !== undefined) {
            threads.set(thread.id, { ...thread, title: command.title });
          }
          return {} as never;
        }),
    }),
  );
  return { layer, threads, bootstrapped, continued, refreshed, commands };
}

const session = (overrides: Partial<DesktopSession>): DesktopSession => ({
  sessionId: "local_a",
  cliSessionId: ids.shared,
  priorCliSessionIds: [],
  cwd: "/work/app",
  originCwd: "/work/app",
  title: "A",
  archived: false,
  lastActivityAtMs: 1_000,
  ...overrides,
});

describe("planDesktopMirror", () => {
  it("creates open sessions whose folder exists, and never archived or foreign ones", () => {
    const actions = DesktopMirror.planDesktopMirror({
      sessions: [
        session({ sessionId: "open" }),
        session({ sessionId: "archived", archived: true }),
        session({ sessionId: "elsewhere", originCwd: "/home/deploy/app", cwd: "/home/deploy/app" }),
      ],
      rows: new Map(),
      folderExists: (folder) => folder === "/work/app",
    });
    expect(actions.map((action) => `${action.type}:${action.session.sessionId}`)).toEqual([
      "create:open",
    ]);
  });

  it("only acts on fields the desktop app changed since the last pass", () => {
    const row: DesktopMirror.MirrorRow = {
      sessionId: "local_a",
      threadId: ThreadId.make("thread-a"),
      title: "A",
      lastActivityAtMs: 1_000,
      archived: false,
    };
    const rows = new Map([[row.sessionId, row]]);
    const folderExists = () => true;
    expect(
      DesktopMirror.planDesktopMirror({ sessions: [session({})], rows, folderExists }),
    ).toEqual([]);
    expect(
      DesktopMirror.planDesktopMirror({
        sessions: [session({ title: "B", lastActivityAtMs: 2_000 })],
        rows,
        folderExists,
      }),
    ).toMatchObject([{ type: "update", rename: true, activity: true, archive: null }]);
    expect(
      DesktopMirror.planDesktopMirror({
        sessions: [session({ archived: true })],
        rows,
        folderExists: () => false,
      }),
    ).toMatchObject([{ type: "update", rename: false, activity: false, archive: true }]);
    expect(
      DesktopMirror.planDesktopMirror({
        sessions: [],
        rows,
        folderExists,
      }),
    ).toEqual([]);
  });
});

describe("findProjectForFolder", () => {
  const projects = [{ workspaceRoot: "/Users/z/Dev/Affinity-OS" }];
  it("folds case on macOS only", () => {
    expect(DesktopMirror.findProjectForFolder(projects, "/Users/z/dev/affinity-os", true)).toBe(
      projects[0],
    );
    expect(
      DesktopMirror.findProjectForFolder(projects, "/Users/z/dev/affinity-os", false),
    ).toBeUndefined();
  });
});

describe("resolveDesktopMirrorConfig", () => {
  const join = (...segments: ReadonlyArray<string>) => segments.join("/").replace(/\/+/g, "/");
  it("is on by default on macOS only, and reads a synced folder when configured", () => {
    expect(
      DesktopMirror.resolveDesktopMirrorConfig({
        settings: {},
        platform: "darwin",
        homeDir: "/Users/z",
        join,
      }),
    ).toEqual({
      enabled: true,
      sessionsDir: "/Users/z/Library/Application Support/Claude/claude-code-sessions",
    });
    expect(
      DesktopMirror.resolveDesktopMirrorConfig({
        settings: {},
        platform: "linux",
        homeDir: "/home/deploy",
        join,
      }).enabled,
    ).toBe(false);
    expect(
      DesktopMirror.resolveDesktopMirrorConfig({
        settings: { enabled: true, sessionsDir: "~/claude-code-sessions" },
        platform: "linux",
        homeDir: "/home/deploy",
        join,
      }),
    ).toEqual({ enabled: true, sessionsDir: "/home/deploy/claude-code-sessions" });
  });
});

describe("DesktopMirror.syncOnce", () => {
  it.effect("mirrors fixture cards once, then propagates an archive without duplicating", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-desktop-mirror-" });
      const fixtures = yield* writeFixtures(root);
      const existingOther = {
        id: ProjectId.make("project-other"),
        workspaceRoot: path.join(root, "work", "other"),
      };
      const fakes = makeFakes([existingOther]);

      yield* Effect.gen(function* () {
        const mirror = yield* DesktopMirror.DesktopMirror;
        const input = { sessionsDir: fixtures.store, claudeHome: fixtures.claudeHome };

        yield* mirror.syncOnce(input);
        // One thread per session across both accounts, titled from the newest card.
        expect(
          fakes.continued.map((call) => [call.providerSessionId, call.title]).toSorted(),
        ).toEqual([
          [ids.shared, "Fix the login page"],
          [ids.caseFolded, "Case folded"],
        ]);
        // The app folder got a project; "Other" reused the project spelled "other".
        expect(fakes.bootstrapped).toEqual([fixtures.app]);
        expect(
          fakes.continued.find((call) => call.providerSessionId === ids.caseFolded)?.projectId,
        ).toBe(existingOther.id);

        // A second pass with nothing changed does nothing.
        expect(yield* mirror.syncOnce(input)).toEqual([]);
        expect(fakes.continued).toHaveLength(2);
        expect(fakes.bootstrapped).toHaveLength(1);

        // Archiving in the desktop app archives the thread, once.
        yield* fs.writeFileString(
          path.join(fixtures.store, "acct-b", "org-2", "backlog", "local_shared.json"),
          card({
            sessionId: "local_shared",
            cliSessionId: ids.shared,
            cwd: fixtures.app,
            title: "Fix the login page",
            isArchived: true,
            lastActivityAt: 3_000,
          }),
        );
        yield* fs.utimes(
          path.join(fixtures.store, "acct-b", "org-2", "backlog", "local_shared.json"),
          3_000,
          3_000,
        );
        yield* mirror.syncOnce(input);
        const sharedThread = ThreadId.make(`import:claudeAgent:${ids.shared}`);
        expect(fakes.commands.map((command) => command.type)).toEqual(["thread.archive"]);
        expect(fakes.threads.get(sharedThread)?.archivedAt).not.toBeNull();
        expect(fakes.threads.size).toBe(2);
        expect(yield* mirror.syncOnce(input)).toEqual([]);
        expect(fakes.commands).toHaveLength(1);
      }).pipe(
        Effect.provide(
          DesktopMirror.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                fakes.layer,
                ServerSettingsService.layerTest(),
                NodeSqliteClient.layer({ filename: ":memory:" }),
                NodeCrypto.layer,
                Layer.succeed(HostProcessPlatform, "darwin"),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
