/**
 * Pure selection logic for the "/resume" finder.
 *
 * The session list + metadata come from the Claude Agent SDK's documented
 * `listSessions({ dir })` (returns `SDKSessionInfo[]`) — NOT from hand-parsing
 * Claude's private transcript format (that would be the same fragile dependency
 * the fork avoids; see docs/adr/0001 "Feasibility verification"). Origin
 * (terminal vs t3) is NOT part of that metadata; it comes from t3's own DB — the
 * Claude session ids t3 created, and the terminal sessions it has imported. See
 * CONTEXT.md ("Importable session", "Session origin").
 *
 * This module is pure: the SDK call and the DB queries live in a thin shell
 * elsewhere, so the filter/flag rules stay unit-testable from plain objects.
 */

/** The subset of the SDK's `SDKSessionInfo` the finder relies on. */
export interface SessionInfo {
  readonly sessionId: string;
  /** Auto-generated title or first prompt (SDK `summary`). */
  readonly summary: string;
  /** User-set title via /rename or `-n` (SDK `customTitle`); preferred when present. */
  readonly customTitle?: string;
  /** Last-modified time, milliseconds since epoch (SDK `lastModified`). */
  readonly lastModified: number;
}

/** A session the `/resume` picker offers, after filtering and flagging. */
export interface ImportableSession {
  readonly sessionId: string;
  readonly title: string;
  readonly lastActivityAt: number;
  readonly alreadyImported: boolean;
  /**
   * When this session has already been imported, the id of the Thread it lives
   * in. Lets the picker REJOIN that existing Thread instead of creating a
   * duplicate (CLI-parity: one conversation, not copies). Plain `string` keeps
   * this module dependency-free; the contract field is branded `ThreadId`
   * (see packages/contracts/src/resume.ts).
   */
  readonly existingThreadId?: string;
}

export interface SelectImportableOptions {
  /** Claude session ids t3 created itself (native t3 Threads) — hidden from the picker. */
  readonly t3OriginSessionIds: ReadonlySet<string>;
  /**
   * Terminal session ids already imported into a Thread, mapped to that
   * Thread's id. Shown in the picker, but flagged and made rejoin-able.
   */
  readonly importedSessions: ReadonlyMap<string, string>;
}

/**
 * Reduce the SDK's project session list to the Importable sessions: the
 * terminal-origin ones (everything t3 did not create itself), each titled and
 * flagged with whether it has already been imported into a Thread (and, if so,
 * which Thread, so the picker can rejoin rather than duplicate).
 */
/** Title and flag one session, attaching its existing Thread id when imported. */
function toImportableSession(
  session: SessionInfo,
  importedSessions: ReadonlyMap<string, string>,
): ImportableSession {
  const existingThreadId = importedSessions.get(session.sessionId);
  return {
    sessionId: session.sessionId,
    title: session.customTitle ?? session.summary,
    lastActivityAt: session.lastModified,
    alreadyImported: existingThreadId !== undefined,
    ...(existingThreadId !== undefined ? { existingThreadId } : {}),
  };
}

export function selectImportableSessions(
  sessions: ReadonlyArray<SessionInfo>,
  options: SelectImportableOptions,
): ReadonlyArray<ImportableSession> {
  return sessions
    .filter((session) => !options.t3OriginSessionIds.has(session.sessionId))
    .map((session) => toImportableSession(session, options.importedSessions));
}

/** The slice of a provider runtime binding the imported-map builder needs. */
export interface ImportedBinding {
  readonly threadId: string;
  /** Resume state; `{ resume: <original Claude session id> }` when set. */
  readonly resumeCursor?: unknown | null;
  /** ISO timestamp of last activity; used to break ties (latest wins). */
  readonly lastSeenAt: string;
}

/**
 * Map each already-imported Claude session id → the t3 Thread that imported it,
 * derived from provider bindings (`resumeCursor.resume` holds the original
 * session id). Bindings are applied oldest-first so the most-recently-active
 * thread wins when pre-fix duplicates already point at the same session — a
 * rejoin then lands on the freshest thread. Bindings without a string `resume`
 * cursor (native t3 threads, other providers) are skipped.
 *
 * Only threads still in `activeThreadIds` (the active snapshot — archived and
 * deleted threads excluded) are mapped. Rejoin must never target an archived or
 * deleted thread: navigating to one bounces the UI home. Resuming such a
 * session instead falls through to a fresh import (with full-history replay),
 * which is the CLI-like outcome.
 */
export function buildImportedSessionMap(
  bindings: ReadonlyArray<ImportedBinding>,
  activeThreadIds: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  const ordered = [...bindings].sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt));
  for (const binding of ordered) {
    if (!activeThreadIds.has(binding.threadId)) {
      continue;
    }
    const cursor = binding.resumeCursor;
    if (cursor && typeof cursor === "object" && "resume" in cursor) {
      const resume = (cursor as { readonly resume?: unknown }).resume;
      if (typeof resume === "string" && resume.length > 0) {
        map.set(resume, binding.threadId);
      }
    }
  }
  return map;
}
