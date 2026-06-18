// apps/web/src/components/sandcastle/sandcastleView.ts
import type {
  SandcastleIssuePhase,
  SandcastleRunState,
  SandcastleStatusEntry,
  SandcastleStatusHistoryEntry,
  SandcastleStatusIssue,
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
  | "outdated" // schemaVersion mismatch
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
const ACTIVE_RUN_STATES = new Set<SandcastleRunState>(["running", "restarting"]);

/** Human relative age of a snapshot vs the reading server's clock, e.g. "11h ago".
 *  Skew-safe (uses serverNow, clamps future timestamps); null if unparseable. */
export function formatRelativeAge(
  updatedAtIso: string,
  serverNowIso: string,
): string | null {
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
  const fromParts =
    identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null;
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
export const TERMINAL_PHASES = new Set<SandcastleIssuePhase>([
  "merged",
  "needs-human",
  "deferred",
]);

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
