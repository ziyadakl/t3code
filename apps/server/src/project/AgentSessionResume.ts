/**
 * The resume picker: list a project's Claude Code sessions from the desktop app
 * and the terminal CLI, and continue one as a T3 Code thread.
 *
 * Those sessions live in the default Claude home (`~/.claude`). T3 Code's Claude
 * provider may run with another home, so resuming hands the transcript off by
 * copying it into the provider's home before importing it with the same
 * importer the first-run wizard uses.
 */
import * as NodeOS from "node:os";

import {
  AgentSessionImportProjectNotFoundError,
  AgentSessionResumeError,
  AgentSessionScanError,
  ThreadId,
  type AgentSessionListResumableInput,
  type AgentSessionListResumableResult,
  type AgentSessionResumeInput,
  type AgentSessionResumeResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ClaudeSessionSources from "./ClaudeSessionSources.ts";
import * as ProjectService from "./ProjectService.ts";

const DESKTOP_STORE_DIR = ["Library", "Application Support", "Claude", "claude-code-sessions"];

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const importer = yield* AgentSessionImporter.AgentSessionImporter;
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDir = NodeOS.homedir();
  const sourceClaudeHome = path.join(homeDir, ".claude");
  const desktopStoreDir = path.join(homeDir, ...DESKTOP_STORE_DIR);

  const getProject = Effect.fn("AgentSessionResume.getProject")(function* (
    projectId: AgentSessionListResumableInput["projectId"],
  ) {
    const project = yield* projects
      .getById(projectId)
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    if (Option.isNone(project)) {
      return yield* new AgentSessionImportProjectNotFoundError({ projectId });
    }
    return project.value;
  });

  /**
   * Live threads in one project already bound to a Claude session id, newest
   * thread last so it wins the lookup. Another project continuing the same
   * session is its own thread and must not be reused here.
   */
  const continuedThreads = Effect.fn("AgentSessionResume.continuedThreads")(function* (
    projectId: AgentSessionListResumableInput["projectId"],
  ) {
    const rows = yield* sql<{ nativeId: string; threadId: string }>`
      SELECT
        json_extract(provider_thread.payload_json, '$.nativeThreadRef.nativeId') AS "nativeId",
        thread.thread_id AS "threadId"
      FROM orchestration_v2_projection_provider_threads AS provider_thread
      JOIN orchestration_v2_projection_threads AS thread
        ON thread.thread_id = provider_thread.thread_id
      WHERE thread.deleted_at IS NULL
        AND thread.project_id = ${projectId}
        AND json_extract(provider_thread.payload_json, '$.nativeThreadRef.nativeId') IS NOT NULL
      ORDER BY thread.updated_at
    `.pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    );
    return new Map(rows.map((row) => [row.nativeId, ThreadId.make(row.threadId)]));
  });

  const listSessions = (workspaceRoot: string, includeArchived: boolean) =>
    ClaudeSessionSources.listClaudeSessions({
      claudeHome: sourceClaudeHome,
      desktopStoreDir,
      workspaceRoot,
      includeArchived,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const listResumable = Effect.fn("AgentSessionResume.listResumable")(function* (
    input: AgentSessionListResumableInput,
  ) {
    const project = yield* getProject(input.projectId);
    const sessions = yield* listSessions(project.workspaceRoot, input.includeArchived === true);
    const continued = yield* continuedThreads(project.id);
    return {
      sessions: sessions.map((session) => ({
        providerSessionId: session.providerSessionId,
        title: session.title,
        updatedAt: DateTime.formatIso(DateTime.makeUnsafe(session.updatedAtMs)),
        origin: session.origin,
        archived: session.archived,
        continuedThreadId: continued.get(session.providerSessionId) ?? null,
      })),
    } satisfies AgentSessionListResumableResult;
  });

  const resume = Effect.fn("AgentSessionResume.resume")(function* (input: AgentSessionResumeInput) {
    const project = yield* getProject(input.projectId);
    const continued = (yield* continuedThreads(project.id)).get(input.providerSessionId);
    if (continued !== undefined) {
      return { threadId: continued, created: false } satisfies AgentSessionResumeResult;
    }

    const session = (yield* listSessions(project.workspaceRoot, true)).find(
      (candidate) => candidate.providerSessionId === input.providerSessionId,
    );
    if (session === undefined) {
      return yield* new AgentSessionResumeError({
        reason: "not-found",
        detail: "That Claude session is no longer in this project's folder.",
      });
    }
    const target = (yield* scanner.providerHomes("claudeAgent"))[0];
    if (target === undefined) {
      return yield* new AgentSessionResumeError({
        reason: "no-provider",
        detail: "Enable a Claude provider to resume Claude sessions.",
      });
    }

    // A session that ran in a worktree resumes there while the worktree exists.
    const inWorktree =
      session.cwd !== project.workspaceRoot &&
      (yield* fileSystem.exists(session.cwd).pipe(Effect.orElseSucceed(() => false)));
    const runCwd = inWorktree ? session.cwd : project.workspaceRoot;

    const transcriptPath = yield* ClaudeSessionSources.handOffTranscript({
      transcriptPath: session.transcriptPath,
      targetHome: target.homePath,
      runCwd,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new AgentSessionResumeError({
            reason: "copy-failed",
            detail: `Could not copy the session into T3 Code's Claude home: ${cause.message}`,
          }),
      ),
    );
    const read = yield* scanner.readThread({
      filePath: transcriptPath,
      source: "claudeAgent",
      providerInstanceId: target.providerInstanceId,
    });
    if (Option.isNone(read)) {
      return yield* new AgentSessionResumeError({
        reason: "import-failed",
        detail: "The session has no conversation T3 Code can read.",
      });
    }
    const threadId = ThreadId.make(
      `import:${target.providerInstanceId}:${read.value.thread.providerSessionId}`,
    );
    const created = yield* importer
      .importThread({
        projectId: project.id,
        workspaceRoot: project.workspaceRoot,
        threadId,
        thread:
          session.origin === "desktop"
            ? { ...read.value.thread, title: session.title }
            : read.value.thread,
        source: read.value.source,
        ...(inWorktree ? { worktreePath: runCwd } : {}),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new AgentSessionResumeError({ reason: "import-failed", detail: cause.message }),
        ),
      );
    return { threadId, created } satisfies AgentSessionResumeResult;
  });

  return { listResumable, resume };
});

type AgentSessionResumeShape = Effect.Success<typeof make>;

export class AgentSessionResume extends Context.Service<
  AgentSessionResume,
  AgentSessionResumeShape
>()("t3/project/AgentSessionResume") {}

export const layer = Layer.effect(AgentSessionResume, make);
