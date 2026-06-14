// apps/web/src/components/sandcastle/sandcastleView.ts
import type {
  SandcastleIssuePhase,
  SandcastleStatusEntry,
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
