// apps/web/src/components/sandcastle/sandcastleView.ts
import type {
  QueueReadyError,
  QueueReadyStatus,
  SandcastleIssuePhase,
  SandcastleRunState,
  SandcastleStatusEntry,
  SandcastleStatusHistoryEntry,
  SandcastleStatusIssue,
  SandcastleStatusSnapshot,
  SandcastleStatusTotals,
} from "@t3tools/contracts";
import type { RepositoryIdentity } from "@t3tools/contracts";
import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@t3tools/shared/git";

/** A snapshot older than this (vs the reading server's clock) reads as stale. */
export const STALE_AFTER_MS = 3 * 60 * 1000;

export type BannerKind =
  | "waiting" // enabled, no status.json yet
  | "live" // running, fresh
  | "stale" // running, no update within STALE_AFTER_MS
  | "done"
  | "stopped"
  | "unhealthy" // terminal failure: finished but left merged work stranded
  | "outdated" // schemaVersion newer than t3 understands
  | "error"; // read/parse failure

export interface Banner {
  readonly kind: BannerKind;
  readonly text: string;
}

export function isStale(updatedAtIso: string, serverNowIso: string): boolean {
  const updated = Date.parse(updatedAtIso);
  const now = Date.parse(serverNowIso);
  if (Number.isNaN(updated) || Number.isNaN(now)) return false;
  return now - updated > STALE_AFTER_MS;
}

/** Run states where the loop is actively progressing — the live/stale banner
 *  already conveys freshness, so no age hint is needed. */
export const ACTIVE_RUN_STATES = new Set<SandcastleRunState>(["running", "restarting"]);

/** True when a run state means the loop is actively progressing. */
export function isActiveRunState(state: SandcastleRunState): boolean {
  return ACTIVE_RUN_STATES.has(state);
}

/** Minimal shape the dashboard grouping needs from one row. */
export interface SandcastleGroupItem<T> {
  readonly item: T;
  /** null = no snapshot ("No run yet"). */
  readonly state: SandcastleRunState | null;
  /** ISO timestamp of the last snapshot update, or null when unknown. */
  readonly updatedAt: string | null;
}

export interface SandcastleGroups<T> {
  readonly running: T[];
  readonly idle: T[];
}

/**
 * Split dashboard rows into a `running` group (state running|restarting) vs an
 * `idle` group (done/stopped/unhealthy/no-run), each sorted by `updatedAt`
 * descending (most recent first). Rows with a null or unparseable `updatedAt`
 * sort last, preserving input order among ties (stable, index-tiebroken sort).
 * Returns the original `T` items in each group.
 */
export function groupSandcastleRows<T>(
  rows: readonly SandcastleGroupItem<T>[],
): SandcastleGroups<T> {
  const running: { item: T; ts: number; index: number }[] = [];
  const idle: { item: T; ts: number; index: number }[] = [];
  rows.forEach((row, index) => {
    const parsed = row.updatedAt !== null ? Date.parse(row.updatedAt) : NaN;
    const ts = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
    const bucket = row.state !== null && ACTIVE_RUN_STATES.has(row.state) ? running : idle;
    bucket.push({ item: row.item, ts, index });
  });
  const sortDescStable = (
    entries: { item: T; ts: number; index: number }[],
  ): T[] =>
    entries
      .toSorted((a, b) => (a.ts !== b.ts ? b.ts - a.ts : a.index - b.index))
      .map((e) => e.item);
  return { running: sortDescStable(running), idle: sortDescStable(idle) };
}

/** Human relative age of a snapshot vs the reading server's clock, e.g. "11h ago".
 *  Skew-safe (uses serverNow, clamps future timestamps); null if unparseable. */
export function formatRelativeAge(updatedAtIso: string, serverNowIso: string): string | null {
  const updated = Date.parse(updatedAtIso);
  const now = Date.parse(serverNowIso);
  if (Number.isNaN(updated) || Number.isNaN(now)) return null;
  const sec = Math.floor(Math.max(0, now - updated) / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/** Age hint to show on FINISHED runs (not running/restarting) so an old snapshot
 *  doesn't look live. Null for active runs or an unparseable timestamp. */
export function finishedRunAgeHint(
  state: SandcastleRunState,
  updatedAtIso: string,
  serverNowIso: string,
): string | null {
  if (ACTIVE_RUN_STATES.has(state)) return null;
  return formatRelativeAge(updatedAtIso, serverNowIso);
}

export function deriveBanner(entry: SandcastleStatusEntry, serverNowIso: string): Banner {
  if (entry.readError) return { kind: "error", text: "Couldn't read status" };
  if (entry.schemaOutdated) return { kind: "outdated", text: "Viewer out of date — update t3" };
  const snap = entry.snapshot;
  if (!snap) return { kind: "waiting", text: "No run yet" };

  switch (snap.state) {
    case "done":
      return { kind: "done", text: "Done" };
    case "stopped":
      return { kind: "stopped", text: "Stopped" };
    case "unhealthy":
      return { kind: "unhealthy", text: "Unhealthy — needs attention" };
    case "running":
    case "restarting":
      return isStale(snap.updatedAt, serverNowIso)
        ? { kind: "stale", text: "Stale — loop may have stopped" }
        : { kind: "live", text: "Live" };
  }
}

/** Build a GitHub issue deep-link from the t3 project's repo identity. */
export function githubIssueUrl(
  identity: RepositoryIdentity | null | undefined,
  issueNumber: number,
): string | null {
  if (!identity) return null;
  const fromParts = identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null;
  const slug =
    fromParts ??
    parseGitHubRepositoryNameWithOwnerFromRemoteUrl(identity.locator?.remoteUrl ?? null);
  if (!slug) return null;
  return `https://github.com/${slug}/issues/${issueNumber}`;
}

const PHASE_LABELS: Record<SandcastleIssuePhase, string> = {
  planned: "Planned",
  implementer: "Implementing",
  reviewer: "Reviewing",
  "implementer-retry": "Retry",
  recovery: "Recovery",
  merge: "Merging",
  merged: "Merged",
  "needs-human": "Needs you",
  deferred: "Deferred",
};

export function phaseLabel(phase: SandcastleIssuePhase): string {
  return PHASE_LABELS[phase] ?? phase;
}

/** Phases that mean an issue is finished (won't progress further this run). */
export const TERMINAL_PHASES = new Set<SandcastleIssuePhase>(["merged", "needs-human", "deferred"]);

/** Split issues into still-in-flight (`active`) vs finished (`recent`). */
export function partitionIssuesByPhase(issues: readonly SandcastleStatusIssue[]): {
  active: SandcastleStatusIssue[];
  recent: SandcastleStatusIssue[];
} {
  const active: SandcastleStatusIssue[] = [];
  const recent: SandcastleStatusIssue[] = [];
  for (const i of issues) {
    (TERMINAL_PHASES.has(i.phase) ? recent : active).push(i);
  }
  return { active, recent };
}

/** One finished-issue row for the "Recent" section. */
export interface RecentFinishedRow {
  readonly number: number;
  readonly title: string;
  readonly phase: SandcastleIssuePhase;
  /** ISO completion time (from history); null for a current-batch terminal issue
   *  not yet recorded to history (so no timestamp is known yet). */
  readonly completedAt: string | null;
  /** The host that produced this row (schema v3 cross-host fusion). Undefined for
   *  a single-host / pre-v3 snapshot. */
  readonly hostId?: string | undefined;
}

/** Newest-first comparator for finished rows. A null completedAt means "just
 *  finished this batch, not yet logged" and sorts ahead of any timestamped row. */
function byCompletedAtDesc(a: RecentFinishedRow, b: RecentFinishedRow): number {
  if (a.completedAt === null && b.completedAt === null) return 0;
  if (a.completedAt === null) return -1;
  if (b.completedAt === null) return 1;
  return Date.parse(b.completedAt) - Date.parse(a.completedAt);
}

/**
 * Core row-derivation shared by the single-host `recentFinishedIssues` and the
 * cross-host `mergedRecentAcrossHosts` (which calls it once per host). Takes a
 * host's own `issues` + optional `history` and tags every produced row with
 * `hostId`. Same logic as the single-host path documented on
 * `recentFinishedIssues` below; kept DRY so a peer (which has `issues` but no
 * `history`) derives rows identically.
 */
function finishedRowsFromIssues(
  issues: readonly SandcastleStatusIssue[],
  history: readonly SandcastleStatusHistoryEntry[] | undefined,
  hostId?: string,
): RecentFinishedRow[] {
  const currentBatchTerminal = partitionIssuesByPhase(issues).recent;

  if (!history) {
    return currentBatchTerminal.map((i) => ({
      number: i.number,
      title: i.title,
      phase: i.phase,
      completedAt: null,
      hostId,
    }));
  }

  const rows: RecentFinishedRow[] = history.map((e) => ({
    number: e.number,
    title: e.title,
    phase: e.phase,
    completedAt: e.completedAt,
    hostId,
  }));

  const seen = new Set(rows.map((r) => r.number));
  for (const i of currentBatchTerminal) {
    if (seen.has(i.number)) continue;
    seen.add(i.number);
    rows.push({ number: i.number, title: i.title, phase: i.phase, completedAt: null, hostId });
  }

  rows.sort(byCompletedAtDesc);
  return rows;
}

/**
 * Finished issues to show in the "Recent" section, across ALL iterations,
 * newest-first.
 *
 * `snap.issues` only ever holds the CURRENT iteration's batch (the loop
 * overwrites it each iteration), so on its own "Recent" looks empty mid-run even
 * after issues have merged. The cumulative record is `snap.history` (append-only).
 * So: prefer history; union in any current-batch terminal issues not yet recorded
 * there (the brief window between finishing and being appended — those sort to the
 * top as freshest); sort the rest by `completedAt` descending.
 *
 * Falls back to the current-batch terminal issues when `history` is absent (older
 * Sandcastle versions predating the history log) — no regression there.
 *
 * Not capped: the caller slices to its display limit so it can render "+N more".
 */
export function recentFinishedIssues(snap: SandcastleStatusSnapshot): RecentFinishedRow[] {
  return finishedRowsFromIssues(snap.issues, snap.history, snap.hostId);
}

// --- cross-host fusion (schema v3) -----------------------------------------
// Pure helpers that fuse ONE snapshot's own data with its `peers[]` into
// host-tagged view models. With no `peers` (and no `hostId`) — an old v2 file —
// every helper degrades to the single-host output the viewer renders today.

/**
 * Field-wise sum of the snapshot's own totals plus each peer's totals. Ships are
 * disjoint across hosts (each host merges its own issues), so summing never
 * double-counts. Returns `snap.totals` unchanged when there are no peers.
 */
export function sumTotalsAcrossHosts(snap: SandcastleStatusSnapshot): SandcastleStatusTotals {
  const peers = snap.peers ?? [];
  if (peers.length === 0) return snap.totals;
  return peers.reduce<SandcastleStatusTotals>(
    (acc, p) => ({
      merged: acc.merged + p.totals.merged,
      needsHuman: acc.needsHuman + p.totals.needsHuman,
      requeued: acc.requeued + p.totals.requeued,
      running: acc.running + p.totals.running,
    }),
    { ...snap.totals },
  );
}

/** One machine's iteration progress. `hostId` is undefined for a v2 own-only snapshot. */
export interface MachineIterations {
  readonly hostId?: string | undefined;
  readonly current: number;
  readonly total: number;
}

/**
 * Iteration progress per machine: the snapshot's own run first, then one entry
 * per peer. Single-host (no peers) ⇒ a one-element array.
 */
export function perMachineIterations(snap: SandcastleStatusSnapshot): MachineIterations[] {
  const own: MachineIterations = {
    hostId: snap.hostId,
    current: snap.run.iterations.current,
    total: snap.run.iterations.total,
  };
  const peers = (snap.peers ?? []).map(
    (p): MachineIterations => ({
      hostId: p.hostId,
      current: p.iterations.current,
      total: p.iterations.total,
    }),
  );
  return [own, ...peers];
}

/**
 * Formatted per-machine progress, e.g. `"Mac 3/8 · Vps 5/8"`. With exactly one
 * machine (no peers) returns a bare `"c/t"` with NO host label, so a single-host
 * snapshot renders exactly as it does today.
 */
export function formatPerMachineIterations(snap: SandcastleStatusSnapshot): string {
  const machines = perMachineIterations(snap);
  if (machines.length === 1) {
    const m = machines[0]!;
    return `${m.current}/${m.total}`;
  }
  return machines
    .map((m) => {
      const label = m.hostId != null ? `${hostBadgeLabel(m.hostId)} ` : "";
      return `${label}${m.current}/${m.total}`;
    })
    .join(" · ");
}

/**
 * Humanize a raw hostId for display: trim, split on `-`/`_`/`.`/whitespace runs,
 * and title-case each word (first letter upper, rest left as-is so an already
 * mixed-case word is preserved). Empty/whitespace input returns "". No hardcoded
 * id→name map — users get friendly names by setting SANDCASTLE_HOST_ID upstream.
 */
export function hostBadgeLabel(hostId: string): string {
  const trimmed = hostId.trim();
  if (trimmed === "") return trimmed;
  return trimmed
    .split(/[-_.\s]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** One active (in-flight) issue tagged with the host running it. */
export interface HostTaggedIssue {
  readonly issue: SandcastleStatusIssue;
  readonly hostId?: string | undefined;
}

/**
 * Union of active (in-flight) issues across all hosts: the snapshot's own active
 * issues (tagged `snap.hostId`) followed by each peer's active issues (tagged the
 * peer's hostId). Single-host ⇒ just own active issues (hostId may be undefined
 * for a v2 file).
 */
export function unionActiveIssuesByHost(snap: SandcastleStatusSnapshot): HostTaggedIssue[] {
  const own = partitionIssuesByPhase(snap.issues).active.map(
    (issue): HostTaggedIssue => ({ issue, hostId: snap.hostId }),
  );
  const peers = (snap.peers ?? []).flatMap((p) =>
    partitionIssuesByPhase(p.issues).active.map(
      (issue): HostTaggedIssue => ({ issue, hostId: p.hostId }),
    ),
  );
  return [...own, ...peers];
}

/**
 * Finished-issue rows across ALL hosts, newest-first. Own rows come from
 * `recentFinishedIssues` (history + current-batch), each tagged `snap.hostId`;
 * each peer contributes rows derived from `peer.issues` the same way (a peer has
 * no history, so its terminal issues surface with a null completedAt and sort to
 * the top). NOT sliced — the component applies its own RECENT_LIMIT. Single-host
 * ⇒ own rows only.
 */
export function mergedRecentAcrossHosts(snap: SandcastleStatusSnapshot): RecentFinishedRow[] {
  const own = finishedRowsFromIssues(snap.issues, snap.history, snap.hostId);
  const peers = (snap.peers ?? []).flatMap((p) =>
    finishedRowsFromIssues(p.issues, undefined, p.hostId),
  );
  return [...own, ...peers].sort(byCompletedAtDesc);
}

/** One display row produced by historyLinksForPhase. */
export interface HistoryLinkRow {
  readonly number: number;
  readonly title: string;
  /** GitHub deep-link, or null when the repo identity can't form a slug. */
  readonly href: string | null;
}

/**
 * Return the displayable rows for a pill popover: history entries that match
 * `phase`, in original order, with duplicates preserved.
 *
 * Returns [] when `history` is undefined/empty or no entries match.
 */
export function historyLinksForPhase(
  history: readonly SandcastleStatusHistoryEntry[] | undefined,
  phase: SandcastleIssuePhase,
  identity: RepositoryIdentity | null | undefined,
): HistoryLinkRow[] {
  if (!history || history.length === 0) return [];
  const rows: HistoryLinkRow[] = [];
  for (const entry of history) {
    if (entry.phase === phase) {
      rows.push({
        number: entry.number,
        title: entry.title,
        href: githubIssueUrl(identity, entry.number),
      });
    }
  }
  return rows;
}

/** How to render the queue-ready count (open issues waiting for Sandcastle). */
export interface QueueReadyDisplay {
  /** Short label, e.g. "3 ready" or "queue unavailable". */
  readonly text: string;
  /** True when the number is stale or unavailable (render muted). */
  readonly muted: boolean;
  /** Tooltip detail. */
  readonly title: string;
}

function queueReadyErrorTitle(error: QueueReadyError): string {
  switch (error) {
    case "gh-missing":
      return "GitHub CLI (gh) is not available on the server.";
    case "gh-unauthed":
      return "GitHub CLI is not signed in (run `gh auth login`).";
    case "query-failed":
      return "Couldn't query GitHub for the queue.";
  }
}

/**
 * Presentation for the queue-ready count, or null when there's nothing to show:
 * the repo isn't GitHub (status null), or the first query is still pending
 * (count null, no error) — we stay silent rather than flash a placeholder.
 * A failed query with a prior count stays visible but muted (stale).
 */
export function queueReadyDisplay(
  status: QueueReadyStatus | null | undefined,
): QueueReadyDisplay | null {
  if (!status) return null;
  if (status.count === null) {
    if (status.error === null) return null; // pending — show nothing yet
    return { text: "queue unavailable", muted: true, title: queueReadyErrorTitle(status.error) };
  }
  const text =
    status.total != null ? `${status.count} of ${status.total} ready` : `${status.count} ready`;
  if (status.error === null) {
    const title =
      status.total != null
        ? `Issues Sandcastle can dispatch now (${status.count}) out of ${status.total} labeled "${status.label}"`
        : `Issues Sandcastle can pick up now (labeled "${status.label}", ready to dispatch)`;
    return {
      text,
      muted: false,
      title,
    };
  }
  return { text, muted: true, title: `Last known count — ${queueReadyErrorTitle(status.error)}` };
}

/** Badge variant for a banner kind — maps to ui/badge.tsx variants. */
export function bannerTone(
  kind: BannerKind,
): "success" | "warning" | "error" | "info" | "secondary" {
  switch (kind) {
    case "live":
      return "success";
    case "stale":
    case "outdated":
      return "warning";
    case "unhealthy":
    case "error":
      return "error";
    case "done":
      return "info";
    case "stopped":
    case "waiting":
      return "secondary";
  }
}

/** The meaningful color a status pill takes once its count is non-zero. */
export type PillVariant = "success" | "warning" | "info" | "secondary";

/** A status count pill is muted (secondary/gray) while its count is zero,
 *  taking its meaningful color only once the count is non-zero — so e.g.
 *  "0 merged" doesn't read as a green success. */
export function pillVariant(count: number, activeVariant: PillVariant): PillVariant {
  return count > 0 ? activeVariant : "secondary";
}
