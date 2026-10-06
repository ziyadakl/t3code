/**
 * The desktop mirror: every open session in the Claude desktop app's Code tab
 * gets a T3 Code thread, in a project for the folder it ran in, without anyone
 * opening the resume picker. It is the picker's import, run for every card.
 *
 * Each pass stats the desktop session cards (re-reading only changed ones),
 * compares them with the sessions it already mirrored, and acts only on the
 * difference: a new open card is imported, a renamed card renames its thread,
 * an archived card archives it (never deletes), and new desktop activity brings
 * the thread's history up to date while T3 Code has not continued it yet.
 * Transcripts are read only for those changed sessions. Threads T3 Code made
 * itself are never touched; the mirror only acts on threads in its own table.
 * The desktop app's files are only ever read.
 */
import * as NodeOS from "node:os";

import { CommandId, ProjectId, ThreadId, type DesktopMirrorSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as AgentSessionResume from "./AgentSessionResume.ts";
import * as ClaudeSessionSources from "./ClaudeSessionSources.ts";
import * as ProjectService from "./ProjectService.ts";

const SYNC_INTERVAL = "1 minute";

/** One desktop session the mirror already bound to a thread, as last applied. */
export interface MirrorRow {
  readonly sessionId: string;
  readonly threadId: ThreadId;
  readonly title: string | null;
  readonly lastActivityAtMs: number;
  readonly archived: boolean;
}

export type MirrorAction =
  | { readonly type: "create"; readonly session: ClaudeSessionSources.DesktopSession }
  | {
      readonly type: "update";
      readonly session: ClaudeSessionSources.DesktopSession;
      readonly row: MirrorRow;
      readonly rename: boolean;
      readonly activity: boolean;
      /** true archives the thread, false restores it, null leaves it. */
      readonly archive: boolean | null;
    };

/** The folder a desktop session belongs to: where it started, not a worktree it moved into. */
export function desktopProjectFolder(session: ClaudeSessionSources.DesktopSession): string {
  return session.originCwd || session.cwd;
}

/**
 * What one pass has to do. An open card whose folder exists here and has no
 * thread yet is created. A card with a thread is compared with what was last
 * applied, so a rename or archive made in T3 Code stands until the desktop
 * app changes that field again. Cards that vanished leave their threads alone.
 */
export function planDesktopMirror(input: {
  readonly sessions: ReadonlyArray<ClaudeSessionSources.DesktopSession>;
  readonly rows: ReadonlyMap<string, MirrorRow>;
  readonly folderExists: (folder: string) => boolean;
}): MirrorAction[] {
  const actions: MirrorAction[] = [];
  for (const session of input.sessions) {
    const row = input.rows.get(session.sessionId);
    if (row === undefined) {
      if (!session.archived && input.folderExists(desktopProjectFolder(session))) {
        actions.push({ type: "create", session });
      }
      continue;
    }
    const rename = session.title !== null && session.title !== row.title;
    const activity = !session.archived && session.lastActivityAtMs > row.lastActivityAtMs;
    const archive = session.archived === row.archived ? null : session.archived;
    if (rename || activity || archive !== null) {
      actions.push({ type: "update", session, row, rename, activity, archive });
    }
  }
  return actions;
}

/**
 * The project already rooted at `folder`. macOS paths match case-insensitively,
 * like the resume picker, so `~/Dev/App` and `~/dev/app` are one project.
 */
export function findProjectForFolder<P extends { readonly workspaceRoot: string }>(
  projects: ReadonlyArray<P>,
  folder: string,
  caseInsensitive: boolean,
): P | undefined {
  const target = ClaudeSessionSources.foldPathCase(folder, caseInsensitive);
  return (
    projects.find((project) => project.workspaceRoot === folder) ??
    projects.find(
      (project) =>
        ClaudeSessionSources.foldPathCase(project.workspaceRoot, caseInsensitive) === target,
    )
  );
}

/** Whether to mirror at all, and where the desktop app's session cards are read from. */
export function resolveDesktopMirrorConfig(input: {
  readonly settings: DesktopMirrorSettings;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly join: (...segments: ReadonlyArray<string>) => string;
}): { readonly enabled: boolean; readonly sessionsDir: string } {
  return {
    enabled: input.settings.enabled ?? input.platform === "darwin",
    sessionsDir: ClaudeSessionSources.resolveDesktopSessionsDir(
      input.homeDir,
      input.settings.sessionsDir,
      input.join,
    ),
  };
}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const resume = yield* AgentSessionResume.AgentSessionResume;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const platform = yield* HostProcessPlatform;
  const caseInsensitive = platform === "darwin";
  const homeDir = NodeOS.homedir();
  const cardCache: ClaudeSessionSources.DesktopCardCache = new Map();
  // Sessions that could not be imported, by the activity they had then, so a
  // failure is retried (and logged) once per desktop change, not every pass.
  const failedImports = new Map<string, number>();

  // Its own table rather than a numbered migration: the mirror is fork-only,
  // and a migration number of ours would collide with upstream's next one.
  yield* sql`
    CREATE TABLE IF NOT EXISTS desktop_mirror_sessions (
      session_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      title TEXT,
      last_activity_at_ms INTEGER NOT NULL,
      archived INTEGER NOT NULL
    )
  `;

  const readRows = sql<{
    sessionId: string;
    threadId: string;
    title: string | null;
    lastActivityAtMs: number;
    archived: number;
  }>`
    SELECT
      session_id AS "sessionId",
      thread_id AS "threadId",
      title,
      last_activity_at_ms AS "lastActivityAtMs",
      archived
    FROM desktop_mirror_sessions
  `.pipe(
    Effect.map(
      (rows) =>
        new Map(
          rows.map((row) => [
            row.sessionId,
            {
              sessionId: row.sessionId,
              threadId: ThreadId.make(row.threadId),
              title: row.title,
              lastActivityAtMs: row.lastActivityAtMs,
              archived: row.archived === 1,
            } satisfies MirrorRow,
          ]),
        ),
    ),
  );

  const writeRow = (row: MirrorRow) => sql`
    INSERT INTO desktop_mirror_sessions (session_id, thread_id, title, last_activity_at_ms, archived)
    VALUES (${row.sessionId}, ${row.threadId}, ${row.title}, ${row.lastActivityAtMs}, ${row.archived ? 1 : 0})
    ON CONFLICT (session_id) DO UPDATE SET
      thread_id = excluded.thread_id,
      title = excluded.title,
      last_activity_at_ms = excluded.last_activity_at_ms,
      archived = excluded.archived
  `;

  const commandId = (operation: string, sessionId: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) =>
        CommandId.make(`server:desktop-mirror:${operation}:${sessionId}:${uuid}`),
      ),
    );

  const toResumable = (
    session: ClaudeSessionSources.DesktopSession,
    transcriptPath: string,
  ): ClaudeSessionSources.ResumableClaudeSession => ({
    providerSessionId: session.cliSessionId,
    title: session.title ?? "Untitled session",
    updatedAtMs: session.lastActivityAtMs,
    origin: "desktop",
    archived: session.archived,
    transcriptPath,
    cwd: session.cwd,
  });

  const findTranscript = (claudeHome: string, session: ClaudeSessionSources.DesktopSession) =>
    ClaudeSessionSources.findDesktopTranscript(claudeHome, session).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  /** The project for a folder, created when none matches. `known` grows as projects are made. */
  const projectFor = Effect.fn("DesktopMirror.projectFor")(function* (
    folder: string,
    known: Array<{ readonly id: ProjectId; readonly workspaceRoot: string }>,
  ) {
    const existing = findProjectForFolder(known, folder, caseInsensitive);
    if (existing !== undefined) return existing;
    const { project } = yield* projects.bootstrap({
      commandId: yield* commandId("project", folder),
      projectId: ProjectId.make(yield* crypto.randomUUIDv4),
      title: path.basename(folder) || folder,
      workspaceRoot: folder,
    });
    known.push(project);
    return project;
  });

  const create = Effect.fn("DesktopMirror.create")(function* (
    claudeHome: string,
    session: ClaudeSessionSources.DesktopSession,
    known: Array<{ readonly id: ProjectId; readonly workspaceRoot: string }>,
  ) {
    const transcriptPath = yield* findTranscript(claudeHome, session);
    if (transcriptPath === null) {
      return yield* Effect.fail("no transcript for this session on this machine");
    }
    const project = yield* projectFor(desktopProjectFolder(session), known);
    const { threadId } = yield* resume.continueSession({
      project,
      session: toResumable(session, transcriptPath),
      keepActive: true,
    });
    yield* writeRow({
      sessionId: session.sessionId,
      threadId,
      title: session.title,
      lastActivityAtMs: session.lastActivityAtMs,
      archived: false,
    });
  });

  const update = Effect.fn("DesktopMirror.update")(function* (
    claudeHome: string,
    action: Extract<MirrorAction, { readonly type: "update" }>,
  ) {
    const { session, row } = action;
    const records = yield* Effect.option(orchestrator.getThreadRecords(row.threadId, []));
    // A thread deleted in T3 Code stays deleted; only the record moves on.
    const thread = Option.getOrUndefined(records)?.thread;
    if (thread !== undefined && thread.deletedAt === null) {
      if (action.archive === true && thread.archivedAt === null) {
        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: yield* commandId("archive", session.sessionId),
          threadId: thread.id,
        });
      }
      if (action.archive === false && thread.archivedAt !== null) {
        yield* orchestrator.dispatch({
          type: "thread.unarchive",
          commandId: yield* commandId("unarchive", session.sessionId),
          threadId: thread.id,
        });
      }
      if (action.rename && session.title !== null && session.title !== thread.title) {
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: yield* commandId("rename", session.sessionId),
          threadId: thread.id,
          title: session.title,
        });
      }
      if (action.activity) {
        const transcriptPath = yield* findTranscript(claudeHome, session);
        const project = yield* projects.getById(thread.projectId);
        if (transcriptPath !== null && Option.isSome(project)) {
          yield* resume.refreshSession({
            project: project.value,
            session: toResumable(session, transcriptPath),
            threadId: thread.id,
          });
        }
        // New desktop activity wakes a settled thread, as activity in T3 Code does.
        if (thread.settledOverride === "settled" && thread.archivedAt === null) {
          yield* orchestrator.dispatch({
            type: "thread.unsettle",
            commandId: yield* commandId("wake", session.sessionId),
            threadId: thread.id,
            reason: "user",
          });
        }
      }
    }
    yield* writeRow({
      sessionId: session.sessionId,
      threadId: row.threadId,
      title: session.title ?? row.title,
      lastActivityAtMs: Math.max(row.lastActivityAtMs, session.lastActivityAtMs),
      archived: session.archived,
    });
  });

  /**
   * One mirror pass over the cards in `sessionsDir`, whose transcripts are
   * under `claudeHome`. Returns the actions it planned.
   */
  const syncOnce = Effect.fn("DesktopMirror.syncOnce")(function* (input: {
    readonly sessionsDir: string;
    readonly claudeHome: string;
  }) {
    const { claudeHome } = input;
    const cards = yield* ClaudeSessionSources.readDesktopCards(input.sessionsDir, cardCache).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    const sessions = ClaudeSessionSources.mergeDesktopCards(cards);
    const rows = yield* readRows;
    const folders = new Set(
      sessions.filter((session) => !rows.has(session.sessionId)).map(desktopProjectFolder),
    );
    const existingFolders = new Set<string>();
    for (const folder of folders) {
      if (folder.length === 0) continue;
      const stats = yield* Effect.option(fileSystem.stat(folder));
      if (Option.isSome(stats) && stats.value.type === "Directory") existingFolders.add(folder);
    }
    const actions = planDesktopMirror({
      sessions,
      rows,
      folderExists: (folder) => existingFolders.has(folder),
    });
    if (actions.length === 0) return actions;

    const known: Array<{ readonly id: ProjectId; readonly workspaceRoot: string }> =
      (yield* projects.snapshot).projects.filter((project) => project.deletedAt === null);
    for (const action of actions) {
      if (action.type === "create") {
        const { session } = action;
        if (failedImports.get(session.sessionId) === session.lastActivityAtMs) continue;
        yield* create(claudeHome, session, known).pipe(
          Effect.tap(() => Effect.sync(() => failedImports.delete(session.sessionId))),
          Effect.catchCause((cause) =>
            Effect.sync(() => failedImports.set(session.sessionId, session.lastActivityAtMs)).pipe(
              Effect.andThen(
                Effect.logWarning("Desktop mirror could not import a session", {
                  sessionId: session.sessionId,
                  cause,
                }),
              ),
            ),
          ),
        );
      } else {
        yield* update(claudeHome, action).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Desktop mirror could not update a thread", {
              sessionId: action.session.sessionId,
              cause,
            }),
          ),
        );
      }
    }
    return actions;
  });

  /** Run a pass with the current settings; a no-op while the mirror is off. */
  const syncNow = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings;
    const config = resolveDesktopMirrorConfig({
      settings: settings.desktopMirror,
      platform,
      homeDir,
      join: path.join,
    });
    if (!config.enabled) return [];
    return yield* syncOnce({
      sessionsDir: config.sessionsDir,
      claudeHome: path.join(homeDir, ".claude"),
    });
  });

  /** Mirror once at server start, then every minute. */
  const start = Effect.fn("DesktopMirror.start")(function* () {
    yield* forkParked(
      syncNow.pipe(
        Effect.catchCause((cause) => Effect.logWarning("Desktop mirror pass failed", { cause })),
        Effect.repeat(Schedule.spaced(SYNC_INTERVAL)),
        Effect.asVoid,
      ),
    );
  });

  return { start, syncOnce };
});

type DesktopMirrorShape = Effect.Success<typeof make>;

export class DesktopMirror extends Context.Service<DesktopMirror, DesktopMirrorShape>()(
  "t3/project/DesktopMirror",
) {}

export const layer = Layer.effect(DesktopMirror, make);
