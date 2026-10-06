/**
 * Claude Code sessions that ran outside T3 Code: in the Claude desktop app's
 * Code tab or in the terminal CLI. Both write transcripts to
 * `<claude home>/projects/<encoded cwd>/<session id>.jsonl`; the desktop app
 * also keeps one session card per session under its application support
 * folder, one folder per account and organization.
 *
 * Everything here only reads those folders, except `handOffTranscript`, which
 * copies a transcript into another Claude home and never touches the source.
 */
import { ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { parseAgentSessionTranscript } from "./AgentSessionScanner.ts";

const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Enough of a transcript to find its cwd and a title without reading it whole. */
const TITLE_PREFIX_BYTES = 256 * 1024;
/**
 * Cap on re-reading a transcript whole after its prefix yielded nothing. A
 * first user message can be far larger than the prefix — one holding an image
 * runs to hundreds of kilobytes — so the prefix is cut mid-record and holds no
 * user message at all, which would drop a real session from the picker.
 */
const MAX_FULL_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
/** The desktop app nests cards at most one folder below an organization folder. */
const MAX_CARD_FOLDER_DEPTH = 4;
const WORKTREE_SEGMENT = "/.claude/worktrees/";

/** Fields of a desktop session card this module reads; the app writes many more. */
const DesktopSessionCard = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  cliSessionId: Schema.optional(Schema.String),
  priorCliSessionIds: Schema.optional(Schema.Array(Schema.String)),
  cwd: Schema.optional(Schema.String),
  originCwd: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  isArchived: Schema.optional(Schema.Boolean),
  lastActivityAt: Schema.optional(Schema.Number),
  createdAt: Schema.optional(Schema.Number),
});
type DesktopSessionCard = typeof DesktopSessionCard.Type;
const decodeDesktopSessionCard = Schema.decodeUnknownOption(
  Schema.fromJsonString(DesktopSessionCard),
);

export interface DesktopCardFile {
  readonly card: DesktopSessionCard;
  readonly mtimeMs: number;
}

/** One desktop session, merged across every account folder holding a copy of its card. */
export interface DesktopSession {
  readonly sessionId: string;
  readonly cliSessionId: string;
  readonly priorCliSessionIds: ReadonlyArray<string>;
  readonly cwd: string;
  readonly originCwd: string;
  readonly title: string | null;
  readonly archived: boolean;
  readonly lastActivityAtMs: number;
}

export interface ResumableClaudeSession {
  readonly providerSessionId: string;
  readonly title: string;
  readonly updatedAtMs: number;
  readonly origin: "desktop" | "cli";
  readonly archived: boolean;
  readonly transcriptPath: string;
  /** Directory the session ran in: the project root or one of its worktrees. */
  readonly cwd: string;
}

const DESKTOP_SESSIONS_DIR = ["Library", "Application Support", "Claude", "claude-code-sessions"];

/**
 * The folder holding the desktop app's session cards: the `desktopMirror.sessionsDir`
 * setting when set (a leading `~` is the home folder), else the app's own folder.
 */
export function resolveDesktopSessionsDir(
  homeDir: string,
  configured: string | undefined,
  join: (...segments: ReadonlyArray<string>) => string,
): string {
  if (configured === undefined) return join(homeDir, ...DESKTOP_SESSIONS_DIR);
  if (configured === "~" || configured.startsWith("~/")) return join(homeDir, configured.slice(1));
  return configured;
}

/** Claude Code's folder name for a cwd under `<home>/projects`. */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Merge card copies by `sessionId`. The newest copy supplies the fields. A
 * session is archived when an archived copy is at least as new as every
 * unarchived copy, so archiving in one account wins over an older live copy
 * left behind in another. Older copies' transcripts count as prior transcripts.
 */
export function mergeDesktopCards(files: ReadonlyArray<DesktopCardFile>): DesktopSession[] {
  const bySession = new Map<string, Array<DesktopCardFile>>();
  for (const file of files) {
    const sessionId = file.card.sessionId?.trim();
    if (!sessionId || !file.card.cliSessionId?.trim()) continue;
    const copies = bySession.get(sessionId);
    if (copies) copies.push(file);
    else bySession.set(sessionId, [file]);
  }

  const sessions: DesktopSession[] = [];
  for (const [sessionId, copies] of bySession) {
    copies.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const newest = copies[0]!.card;
    const cliSessionId = newest.cliSessionId!.trim();
    const newestUnarchivedMs = Math.max(
      -Infinity,
      ...copies.filter((copy) => copy.card.isArchived !== true).map((copy) => copy.mtimeMs),
    );
    const archived = copies.some(
      (copy) => copy.card.isArchived === true && copy.mtimeMs >= newestUnarchivedMs,
    );
    const prior = new Set<string>();
    for (const copy of copies) {
      for (const id of copy.card.priorCliSessionIds ?? []) prior.add(id);
      const copyCliSessionId = copy.card.cliSessionId?.trim();
      if (copyCliSessionId) prior.add(copyCliSessionId);
    }
    prior.delete(cliSessionId);
    const cwd = newest.cwd?.trim() || newest.originCwd?.trim() || "";
    sessions.push({
      sessionId,
      cliSessionId,
      priorCliSessionIds: [...prior],
      cwd,
      originCwd: newest.originCwd?.trim() || cwd,
      title: newest.title?.trim() || null,
      archived,
      lastActivityAtMs: Math.max(
        ...copies.map((copy) => copy.card.lastActivityAt ?? copy.card.createdAt ?? copy.mtimeMs),
      ),
    });
  }
  return sessions;
}

/**
 * macOS file systems are case-insensitive by default, so the same directory
 * reaches us in more than one spelling: a project added as
 * `~/Dev/Affinity/Affinity-OS` holds sessions whose recorded cwd (and whose
 * transcript folder name) says `affinity-os`. Comparing those exactly shows an
 * empty picker. The shared comparison helper already case folds Windows paths,
 * so only macOS needs folding here; other platforms keep exact matching.
 */
export function foldPathCase(value: string, caseInsensitive: boolean): string {
  const normalized = normalizeProjectPathForComparison(value);
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

/** Whether `cwd` is the project root or a Claude worktree inside it. */
function isProjectCwd(cwd: string, workspaceRoot: string, caseInsensitive: boolean): boolean {
  if (cwd.trim().length === 0) return false;
  const normalizedCwd = foldPathCase(cwd, caseInsensitive);
  const normalizedRoot = foldPathCase(workspaceRoot, caseInsensitive);
  return (
    normalizedCwd === normalizedRoot ||
    normalizedCwd.startsWith(normalizedRoot.replace(/\/+$/, "") + WORKTREE_SEGMENT)
  );
}

function desktopSessionInProject(
  session: DesktopSession,
  workspaceRoot: string,
  caseInsensitive: boolean,
): boolean {
  return (
    isProjectCwd(session.originCwd, workspaceRoot, caseInsensitive) ||
    isProjectCwd(session.cwd, workspaceRoot, caseInsensitive)
  );
}

/** Cards already read, by path, so an unchanged card is only stat'ed on the next read. */
export type DesktopCardCache = Map<string, DesktopCardFile>;

/**
 * Every `local_*.json` card under the desktop store, across all account and org
 * folders. With a `cache`, a card whose mtime is unchanged is not re-read, and
 * the cache is pruned to the cards still present.
 */
export const readDesktopCards = Effect.fn("ClaudeSessionSources.readDesktopCards")(function* (
  storeDir: string,
  cache?: DesktopCardCache,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cards: DesktopCardFile[] = [];
  const seen = new Set<string>();

  const visit = (directory: string, depth: number): Effect.Effect<void> =>
    Effect.gen(function* () {
      const entries = yield* fileSystem
        .readDirectory(directory)
        .pipe(Effect.orElseSucceed((): string[] => []));
      for (const entry of entries.toSorted()) {
        const entryPath = path.join(directory, entry);
        const stats = yield* Effect.option(fileSystem.stat(entryPath));
        if (Option.isNone(stats)) continue;
        if (stats.value.type === "Directory") {
          if (depth < MAX_CARD_FOLDER_DEPTH) yield* visit(entryPath, depth + 1);
          continue;
        }
        if (
          stats.value.type !== "File" ||
          !entry.startsWith("local_") ||
          !entry.endsWith(".json")
        ) {
          continue;
        }
        const mtimeMs = Option.match(stats.value.mtime, {
          onNone: () => 0,
          onSome: (date) => date.getTime(),
        });
        seen.add(entryPath);
        const cached = cache?.get(entryPath);
        if (cached !== undefined && cached.mtimeMs === mtimeMs) {
          cards.push(cached);
          continue;
        }
        const contents = yield* Effect.option(fileSystem.readFileString(entryPath));
        if (Option.isNone(contents)) continue;
        const card = decodeDesktopSessionCard(contents.value);
        if (Option.isNone(card)) continue;
        const file = { card: card.value, mtimeMs };
        cache?.set(entryPath, file);
        cards.push(file);
      }
    });

  yield* visit(storeDir, 1);
  if (cache !== undefined) {
    for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
  }
  return cards;
});

/** The desktop session's current transcript under `claudeHome`, or null when it is not on this machine. */
export const findDesktopTranscript = Effect.fn("ClaudeSessionSources.findDesktopTranscript")(
  function* (claudeHome: string, session: DesktopSession) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!CLAUDE_SESSION_ID_PATTERN.test(session.cliSessionId)) return null;
    for (const cwd of new Set([session.cwd, session.originCwd])) {
      const candidate = path.join(
        claudeHome,
        "projects",
        encodeClaudeProjectDir(cwd),
        `${session.cliSessionId}.jsonl`,
      );
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        return candidate;
      }
    }
    return null;
  },
);

/** The first records of a transcript, cut at the last complete line. */
const readTranscriptPrefix = Effect.fn("ClaudeSessionSources.readTranscriptPrefix")(function* (
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fileSystem.open(filePath, { flag: "r" });
      const chunk = yield* file.readAlloc(TITLE_PREFIX_BYTES);
      if (Option.isNone(chunk)) return "";
      const text = new TextDecoder().decode(chunk.value);
      if (chunk.value.byteLength < TITLE_PREFIX_BYTES) return text;
      const lastNewline = text.lastIndexOf("\n");
      return lastNewline === -1 ? "" : text.slice(0, lastNewline + 1);
    }),
  ).pipe(Effect.orElseSucceed(() => ""));
});

/**
 * A whole transcript, but only when its prefix was cut short — a file no bigger
 * than the prefix was already read entirely, so a session with no user message
 * in it has none at all and stays out of the picker. `null` when there is
 * nothing more to read, or the file is too big to hold in memory.
 */
const readTranscriptRest = Effect.fn("ClaudeSessionSources.readTranscriptRest")(function* (
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const size = yield* fileSystem.stat(filePath).pipe(
    Effect.map((stats) => Number(stats.size)),
    Effect.orElseSucceed(() => 0),
  );
  if (size <= TITLE_PREFIX_BYTES || size > MAX_FULL_TRANSCRIPT_BYTES) return null;
  return yield* fileSystem
    .readFileString(filePath)
    .pipe(Effect.orElseSucceed((): string | null => null));
});

function firstCwd(contents: string): string | null {
  for (const line of contents.split("\n")) {
    if (!line.includes('"cwd"')) continue;
    try {
      const record = JSON.parse(line) as { cwd?: unknown };
      if (typeof record.cwd === "string" && record.cwd.trim().length > 0) return record.cwd;
    } catch {
      // A malformed record says nothing about the cwd.
    }
  }
  return null;
}

/**
 * Sessions in `workspaceRoot` (or its Claude worktrees) that can be resumed:
 * one row per desktop session, then CLI transcripts no desktop card claims.
 * Newest first. Archived desktop sessions appear only with `includeArchived`.
 */
export const listClaudeSessions = Effect.fn("ClaudeSessionSources.listClaudeSessions")(
  function* (input: {
    readonly claudeHome: string;
    readonly desktopStoreDir: string;
    readonly workspaceRoot: string;
    readonly includeArchived: boolean;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const caseInsensitive = (yield* HostProcessPlatform) === "darwin";
    const projectsDir = path.join(input.claudeHome, "projects");
    const mtimeMs = (target: string) =>
      fileSystem.stat(target).pipe(
        Effect.map((stats) =>
          Option.match(stats.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
        ),
        Effect.orElseSucceed(() => 0),
      );

    const desktopSessions = mergeDesktopCards(yield* readDesktopCards(input.desktopStoreDir));
    // Transcripts any desktop session owns, in any project, never become CLI rows.
    const claimedTranscripts = new Set<string>();
    for (const session of desktopSessions) {
      claimedTranscripts.add(session.cliSessionId);
      for (const id of session.priorCliSessionIds) claimedTranscripts.add(id);
    }

    const rows: ResumableClaudeSession[] = [];
    for (const session of desktopSessions) {
      if (!desktopSessionInProject(session, input.workspaceRoot, caseInsensitive)) continue;
      if (session.archived && !input.includeArchived) continue;
      const transcriptPath = yield* findDesktopTranscript(input.claudeHome, session);
      if (transcriptPath === null) continue;
      rows.push({
        providerSessionId: session.cliSessionId,
        title: session.title ?? "Untitled session",
        updatedAtMs: session.lastActivityAtMs,
        origin: "desktop",
        archived: session.archived,
        transcriptPath,
        cwd: session.cwd,
      });
    }

    const foldDirCase = (value: string) => (caseInsensitive ? value.toLowerCase() : value);
    const rootDir = foldDirCase(encodeClaudeProjectDir(input.workspaceRoot));
    const projectDirs = (yield* fileSystem
      .readDirectory(projectsDir)
      .pipe(Effect.orElseSucceed((): string[] => []))).filter((entry) => {
      const folded = foldDirCase(entry);
      return folded === rootDir || folded.startsWith(`${rootDir}--claude-worktrees-`);
    });
    for (const projectDir of projectDirs.toSorted()) {
      const directory = path.join(projectsDir, projectDir);
      const entries = yield* fileSystem
        .readDirectory(directory)
        .pipe(Effect.orElseSucceed((): string[] => []));
      for (const entry of entries.toSorted()) {
        if (!entry.endsWith(".jsonl")) continue;
        const sessionId = entry.slice(0, -".jsonl".length);
        if (!CLAUDE_SESSION_ID_PATTERN.test(sessionId) || claimedTranscripts.has(sessionId)) {
          continue;
        }
        const transcriptPath = path.join(directory, entry);
        const updatedAtMs = yield* mtimeMs(transcriptPath);
        const read = (contents: string) => ({
          // Folder names are lossy encodings; the transcript's own cwd decides.
          cwd: firstCwd(contents),
          thread: parseAgentSessionTranscript({
            source: "claudeAgent",
            providerInstanceId: ProviderInstanceId.make("claudeAgent"),
            fallbackSessionId: sessionId,
            lastActiveAtMs: updatedAtMs,
            contents,
          }),
        });
        let parsed = read(yield* readTranscriptPrefix(transcriptPath));
        if (parsed.cwd === null || parsed.thread === null) {
          const whole = yield* readTranscriptRest(transcriptPath);
          if (whole !== null) parsed = read(whole);
        }
        const { cwd, thread } = parsed;
        if (cwd === null || !isProjectCwd(cwd, input.workspaceRoot, caseInsensitive)) continue;
        if (thread === null) continue;
        rows.push({
          providerSessionId: sessionId,
          title: thread.title,
          updatedAtMs,
          origin: "cli",
          archived: false,
          transcriptPath,
          cwd,
        });
      }
    }

    return rows.toSorted((left, right) => right.updatedAtMs - left.updatedAtMs);
  },
);

/**
 * Copy a transcript, and the sibling folder Claude keeps for the same session
 * (subagent and tool-result files), into `targetHome` under the folder Claude
 * reads when resuming in `runCwd`. Returns the transcript path to resume from.
 * The source is only read. A copy already at the destination is replaced.
 */
export const handOffTranscript = Effect.fn("ClaudeSessionSources.handOffTranscript")(
  function* (input: {
    readonly transcriptPath: string;
    readonly targetHome: string;
    readonly runCwd: string;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sessionFile = path.basename(input.transcriptPath);
    const sessionId = sessionFile.replace(/\.jsonl$/, "");
    const targetDir = path.join(input.targetHome, "projects", encodeClaudeProjectDir(input.runCwd));
    const targetPath = path.join(targetDir, sessionFile);
    if (path.resolve(targetPath) === path.resolve(input.transcriptPath)) return targetPath;

    yield* fileSystem.makeDirectory(targetDir, { recursive: true });
    const staging = `${targetPath}.handoff-${process.pid}-${yield* Clock.currentTimeMillis}`;
    yield* fileSystem.copyFile(input.transcriptPath, staging);
    yield* fileSystem.rename(staging, targetPath);

    const siblingDir = path.join(path.dirname(input.transcriptPath), sessionId);
    const sibling = yield* Effect.option(fileSystem.stat(siblingDir));
    if (Option.isSome(sibling) && sibling.value.type === "Directory") {
      yield* fileSystem.copy(siblingDir, path.join(targetDir, sessionId), { overwrite: true });
    }
    return targetPath;
  },
);
