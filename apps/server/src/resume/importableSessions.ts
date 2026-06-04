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
}

export interface SelectImportableOptions {
  /** Claude session ids t3 created itself (native t3 Threads) — hidden from the picker. */
  readonly t3OriginSessionIds: ReadonlySet<string>;
  /** Terminal session ids already imported into a Thread — shown, but flagged. */
  readonly importedSessionIds: ReadonlySet<string>;
}

/**
 * Reduce the SDK's project session list to the Importable sessions: the
 * terminal-origin ones (everything t3 did not create itself), each titled and
 * flagged with whether it has already been imported into a Thread.
 */
export function selectImportableSessions(
  sessions: ReadonlyArray<SessionInfo>,
  options: SelectImportableOptions,
): ReadonlyArray<ImportableSession> {
  return sessions
    .filter((session) => !options.t3OriginSessionIds.has(session.sessionId))
    .map((session) => ({
      sessionId: session.sessionId,
      title: session.customTitle ?? session.summary,
      lastActivityAt: session.lastModified,
      alreadyImported: options.importedSessionIds.has(session.sessionId),
    }));
}
