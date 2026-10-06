import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  encodeClaudeProjectDir,
  handOffTranscript,
  listClaudeSessions,
  mergeDesktopCards,
} from "./ClaudeSessionSources.ts";

const PROJECT = "/work/app";
const WORKTREE = "/work/app/.claude/worktrees/brave-fox";

const ids = {
  desktopLive: "11111111-1111-4111-8111-111111111111",
  desktopLivePrior: "22222222-2222-4222-8222-222222222222",
  desktopArchived: "33333333-3333-4333-8333-333333333333",
  desktopWorktree: "44444444-4444-4444-8444-444444444444",
  cliOnly: "55555555-5555-4555-8555-555555555555",
  otherProject: "66666666-6666-4666-8666-666666666666",
  cliHugeFirstMessage: "77777777-7777-4777-8777-777777777777",
};

/** Mirrors the reader's prefix cap: the first user record has to run past it. */
const HUGE_MESSAGE_TEXT = `Look at this screenshot\n${"a".repeat(400 * 1024)}`;

function transcript(sessionId: string, cwd: string, text: string): string {
  return (
    [
      {
        type: "user",
        cwd,
        sessionId,
        uuid: `${sessionId}-u`,
        timestamp: "2026-10-01T10:00:00.000Z",
        message: { role: "user", content: text },
      },
      {
        type: "assistant",
        cwd,
        sessionId,
        uuid: `${sessionId}-a`,
        timestamp: "2026-10-01T10:01:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n"
  );
}

const card = (fields: Record<string, unknown>) => JSON.stringify(fields);

/** Two accounts, an archive made later in the second, a worktree, and a prior-transcript chain. */
const writeFixtures = Effect.fn("writeFixtures")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = path.join(root, "claude-home");
  const store = path.join(root, "desktop-store");
  const accountA = path.join(store, "acct-a", "org-1");
  const accountB = path.join(store, "acct-b", "org-2");
  yield* fs.makeDirectory(path.join(accountA, "backlog"), { recursive: true });
  yield* fs.makeDirectory(path.join(accountB, "waiting-input"), { recursive: true });

  const write = (filePath: string, contents: string, mtimeSeconds: number) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fs.writeFileString(filePath, contents);
      yield* fs.utimes(filePath, mtimeSeconds, mtimeSeconds);
    });

  // Live desktop session, whose transcript was replaced once (prior id).
  yield* write(
    path.join(accountA, "local_live.json"),
    card({
      sessionId: "local_live",
      cliSessionId: ids.desktopLive,
      priorCliSessionIds: [ids.desktopLivePrior],
      cwd: PROJECT,
      originCwd: PROJECT,
      title: "Desktop live",
      isArchived: false,
      lastActivityAt: 3_000,
    }),
    100,
  );
  // Archived: unarchived in account A, archived later in account B.
  yield* write(
    path.join(accountA, "local_arch.json"),
    card({
      sessionId: "local_arch",
      cliSessionId: ids.desktopArchived,
      cwd: PROJECT,
      originCwd: PROJECT,
      title: "Desktop archived",
      isArchived: false,
      lastActivityAt: 2_000,
    }),
    100,
  );
  yield* write(
    path.join(accountB, "local_arch.json"),
    card({
      sessionId: "local_arch",
      cliSessionId: ids.desktopArchived,
      cwd: PROJECT,
      originCwd: PROJECT,
      title: "Desktop archived",
      isArchived: true,
      lastActivityAt: 2_000,
    }),
    200,
  );
  // Worktree session, card nested in an account subfolder.
  yield* write(
    path.join(accountB, "waiting-input", "local_wt.json"),
    card({
      sessionId: "local_wt",
      cliSessionId: ids.desktopWorktree,
      cwd: WORKTREE,
      originCwd: PROJECT,
      title: "Desktop worktree",
      isArchived: false,
      lastActivityAt: 4_000,
    }),
    100,
  );
  // Not a session card.
  yield* write(path.join(accountA, "backlog", "tasks.json"), '{"version":1,"items":[]}', 100);

  const projectDir = path.join(home, "projects", encodeClaudeProjectDir(PROJECT));
  const worktreeDir = path.join(home, "projects", encodeClaudeProjectDir(WORKTREE));
  yield* write(
    path.join(projectDir, `${ids.desktopLive}.jsonl`),
    transcript(ids.desktopLive, PROJECT, "live"),
    3,
  );
  yield* write(
    path.join(projectDir, `${ids.desktopLivePrior}.jsonl`),
    transcript(ids.desktopLivePrior, PROJECT, "prior"),
    2,
  );
  yield* write(
    path.join(projectDir, `${ids.desktopArchived}.jsonl`),
    transcript(ids.desktopArchived, PROJECT, "archived"),
    2,
  );
  yield* write(
    path.join(worktreeDir, `${ids.desktopWorktree}.jsonl`),
    transcript(ids.desktopWorktree, WORKTREE, "worktree"),
    4,
  );
  yield* write(
    path.join(projectDir, `${ids.cliOnly}.jsonl`),
    transcript(ids.cliOnly, PROJECT, "Terminal work\nmore"),
    1,
  );
  // One user record far bigger than the prefix cap, so the prefix holds no
  // complete line at all.
  yield* write(
    path.join(projectDir, `${ids.cliHugeFirstMessage}.jsonl`),
    transcript(ids.cliHugeFirstMessage, PROJECT, HUGE_MESSAGE_TEXT),
    6,
  );
  yield* write(
    path.join(home, "projects", encodeClaudeProjectDir("/work/other"), `${ids.otherProject}.jsonl`),
    transcript(ids.otherProject, "/work/other", "other"),
    5,
  );
  return { home, store };
});

it("archives a session when its archived copy is the newest", () => {
  const base = { sessionId: "s", cliSessionId: ids.desktopLive, cwd: PROJECT };
  const merged = (archivedMtime: number) =>
    mergeDesktopCards([
      { card: { ...base, isArchived: false }, mtimeMs: 10 },
      { card: { ...base, isArchived: true }, mtimeMs: archivedMtime },
    ])[0]?.archived;
  expect(merged(20)).toBe(true);
  expect(merged(5)).toBe(false);
});

it.layer(NodeServices.layer)("Claude session sources", (it) => {
  it.effect("lists one row per desktop session plus unclaimed CLI transcripts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-sources-" });
      const { home, store } = yield* writeFixtures(root);

      const listed = yield* listClaudeSessions({
        claudeHome: home,
        desktopStoreDir: store,
        workspaceRoot: PROJECT,
        includeArchived: false,
      });
      expect(
        listed.map(({ providerSessionId, origin, title, archived, cwd }) => ({
          providerSessionId,
          origin,
          title,
          archived,
          cwd,
        })),
      ).toEqual([
        {
          providerSessionId: ids.cliHugeFirstMessage,
          origin: "cli",
          title: "Look at this screenshot",
          archived: false,
          cwd: PROJECT,
        },
        {
          providerSessionId: ids.desktopWorktree,
          origin: "desktop",
          title: "Desktop worktree",
          archived: false,
          cwd: WORKTREE,
        },
        {
          providerSessionId: ids.desktopLive,
          origin: "desktop",
          title: "Desktop live",
          archived: false,
          cwd: PROJECT,
        },
        {
          providerSessionId: ids.cliOnly,
          origin: "cli",
          title: "Terminal work",
          archived: false,
          cwd: PROJECT,
        },
      ]);

      const withArchived = yield* listClaudeSessions({
        claudeHome: home,
        desktopStoreDir: store,
        workspaceRoot: PROJECT,
        includeArchived: true,
      });
      expect(
        withArchived.filter((row) => row.archived).map((row) => row.providerSessionId),
      ).toEqual([ids.desktopArchived]);
    }),
  );

  it.effect("lists a session whose first user message is larger than the read prefix", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-huge-" });
      const { home, store } = yield* writeFixtures(root);
      const transcriptPath = path.join(
        home,
        "projects",
        encodeClaudeProjectDir(PROJECT),
        `${ids.cliHugeFirstMessage}.jsonl`,
      );
      // The fixture only tests the fix while it really exceeds the cap.
      expect(Number((yield* fs.stat(transcriptPath)).size)).toBeGreaterThan(256 * 1024);

      const listed = yield* listClaudeSessions({
        claudeHome: home,
        desktopStoreDir: store,
        workspaceRoot: PROJECT,
        includeArchived: false,
      });
      expect(listed.find((row) => row.providerSessionId === ids.cliHugeFirstMessage)).toMatchObject(
        {
          origin: "cli",
          title: "Look at this screenshot",
          cwd: PROJECT,
        },
      );
    }),
  );

  it.effect("matches a differently cased project path on macOS only", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-case-" });
      const { home, store } = yield* writeFixtures(root);
      const listCased = (platform: NodeJS.Platform) =>
        listClaudeSessions({
          claudeHome: home,
          desktopStoreDir: store,
          workspaceRoot: "/Work/App",
          includeArchived: false,
        }).pipe(Effect.provideService(HostProcessPlatform, platform));

      // macOS file systems are case-insensitive, so these are one project.
      expect((yield* listCased("darwin")).map((row) => row.providerSessionId)).toEqual([
        ids.cliHugeFirstMessage,
        ids.desktopWorktree,
        ids.desktopLive,
        ids.cliOnly,
      ]);
      // Linux file systems are case-sensitive, so these are different paths.
      expect(yield* listCased("linux")).toEqual([]);
    }),
  );

  it.effect("hands a transcript and its session folder off without changing the source", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-handoff-" });
      const { home } = yield* writeFixtures(root);
      const sourceDir = path.join(home, "projects", encodeClaudeProjectDir(WORKTREE));
      const sourcePath = path.join(sourceDir, `${ids.desktopWorktree}.jsonl`);
      yield* fs.makeDirectory(path.join(sourceDir, ids.desktopWorktree, "subagents"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(sourceDir, ids.desktopWorktree, "subagents", "agent-1.jsonl"),
        "{}\n",
      );
      const before = yield* fs.readFileString(sourcePath);
      const poolHome = path.join(root, "claude-pool");

      const copied = yield* handOffTranscript({
        transcriptPath: sourcePath,
        targetHome: poolHome,
        runCwd: WORKTREE,
      });
      expect(copied).toBe(
        path.join(
          poolHome,
          "projects",
          encodeClaudeProjectDir(WORKTREE),
          `${ids.desktopWorktree}.jsonl`,
        ),
      );
      expect(yield* fs.readFileString(copied)).toBe(before);
      expect(
        yield* fs.readFileString(
          path.join(path.dirname(copied), ids.desktopWorktree, "subagents", "agent-1.jsonl"),
        ),
      ).toBe("{}\n");
      expect(yield* fs.readFileString(sourcePath)).toBe(before);

      // Resuming in the project root once the worktree is gone files it under the root.
      const atRoot = yield* handOffTranscript({
        transcriptPath: sourcePath,
        targetHome: poolHome,
        runCwd: PROJECT,
      });
      expect(path.dirname(atRoot)).toBe(
        path.join(poolHome, "projects", encodeClaudeProjectDir(PROJECT)),
      );

      // Same home and folder: nothing to copy.
      expect(
        yield* handOffTranscript({
          transcriptPath: sourcePath,
          targetHome: home,
          runCwd: WORKTREE,
        }),
      ).toBe(sourcePath);
    }),
  );
});
