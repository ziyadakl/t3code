// apps/web/src/components/sandcastle/sandcastleView.test.ts
import { describe, it, expect } from "vite-plus/test";
import {
  deriveBanner,
  bannerTone,
  isStale,
  githubIssueUrl,
  phaseLabel,
  partitionIssuesByPhase,
  recentFinishedIssues,
  queueReadyDisplay,
  formatRelativeAge,
  finishedRunAgeHint,
  historyLinksForPhase,
  STALE_AFTER_MS,
} from "./sandcastleView.ts";
import type {
  RepositoryIdentity,
  SandcastleStatusEntry,
  SandcastleStatusHistoryEntry,
  SandcastleStatusIssue,
  SandcastleStatusSnapshot,
} from "@t3tools/contracts";

function entry(over: Partial<SandcastleStatusEntry>): SandcastleStatusEntry {
  return {
    cwd: "/p",
    hasSandcastleDir: true,
    snapshot: null,
    schemaOutdated: false,
    readError: null,
    ...over,
  };
}

/** Build a real RepositoryIdentity (mirrors environmentGrouping.test.ts fixtures). */
function identity(
  over: { owner?: string; name?: string; remoteUrl?: string } = {},
): RepositoryIdentity {
  const remoteUrl = over.remoteUrl ?? "https://github.com/example/repo.git";
  return {
    canonicalKey: remoteUrl,
    locator: { source: "git-remote", remoteName: "origin", remoteUrl },
    ...(over.owner !== undefined ? { owner: over.owner } : {}),
    ...(over.name !== undefined ? { name: over.name } : {}),
  };
}

const runningSnapshot = {
  schemaVersion: 1,
  state: "running" as const,
  run: {
    branch: "b",
    repo: "r",
    startedAt: "x",
    iterations: { current: 1, total: 9 },
    maxConcurrent: 1,
  },
  totals: { merged: 0, needsHuman: 0, requeued: 0, running: 1 },
  issues: [],
  updatedAt: "2026-06-04T12:00:00.000Z",
};

describe("isStale", () => {
  it("is false within the window", () => {
    const now = new Date("2026-06-04T12:01:00.000Z").toISOString();
    expect(isStale(runningSnapshot.updatedAt, now)).toBe(false);
  });
  it("is true past the window", () => {
    const now = new Date(
      Date.parse(runningSnapshot.updatedAt) + STALE_AFTER_MS + 1000,
    ).toISOString();
    expect(isStale(runningSnapshot.updatedAt, now)).toBe(true);
  });
});

describe("deriveBanner", () => {
  const now = "2026-06-04T12:00:30.000Z";
  it("waiting when enabled but no snapshot", () => {
    expect(deriveBanner(entry({ snapshot: null }), now).kind).toBe("waiting");
  });
  it("outdated wins", () => {
    expect(deriveBanner(entry({ schemaOutdated: true }), now).kind).toBe("outdated");
  });
  it("error when readError present", () => {
    expect(deriveBanner(entry({ readError: "boom" }), now).kind).toBe("error");
  });
  it("live when running and fresh", () => {
    expect(deriveBanner(entry({ snapshot: runningSnapshot }), now).kind).toBe("live");
  });
  it("stale when running and old", () => {
    const late = new Date(
      Date.parse(runningSnapshot.updatedAt) + STALE_AFTER_MS + 1000,
    ).toISOString();
    expect(deriveBanner(entry({ snapshot: runningSnapshot }), late).kind).toBe("stale");
  });
  it("done state", () => {
    expect(deriveBanner(entry({ snapshot: { ...runningSnapshot, state: "done" } }), now).kind).toBe(
      "done",
    );
  });
  it("stopped state", () => {
    expect(
      deriveBanner(entry({ snapshot: { ...runningSnapshot, state: "stopped" } }), now).kind,
    ).toBe("stopped");
  });
  it("unhealthy state (terminal failure)", () => {
    expect(
      deriveBanner(entry({ snapshot: { ...runningSnapshot, state: "unhealthy" } }), now).kind,
    ).toBe("unhealthy");
  });
});

describe("bannerTone", () => {
  it("maps unhealthy to error (red)", () => {
    expect(bannerTone("unhealthy")).toBe("error");
  });
});

describe("githubIssueUrl", () => {
  it("builds from owner+name", () => {
    expect(githubIssueUrl(identity({ owner: "acme", name: "widgets" }), 42)).toBe(
      "https://github.com/acme/widgets/issues/42",
    );
  });
  it("falls back to remoteUrl parsing", () => {
    expect(githubIssueUrl(identity({ remoteUrl: "git@github.com:acme/widgets.git" }), 7)).toBe(
      "https://github.com/acme/widgets/issues/7",
    );
  });
  it("returns null when nothing usable", () => {
    expect(githubIssueUrl(null, 1)).toBeNull();
  });
});

describe("phaseLabel", () => {
  it("humanizes phases", () => {
    expect(phaseLabel("implementer-retry")).toBe("Retry");
    expect(phaseLabel("needs-human")).toBe("Needs you");
    expect(phaseLabel("merged")).toBe("Merged");
  });
});

function issue(number: number, phase: SandcastleStatusIssue["phase"]): SandcastleStatusIssue {
  return { number, title: `#${number}`, branch: "b", phase };
}

describe("partitionIssuesByPhase", () => {
  it("splits active (in-flight) from recent (terminal) phases", () => {
    const issues = [
      issue(1, "implementer"),
      issue(2, "merged"),
      issue(3, "reviewer"),
      issue(4, "needs-human"),
      issue(5, "deferred"),
    ];
    const { active, recent } = partitionIssuesByPhase(issues);
    expect(active.map((i) => i.number)).toEqual([1, 3]);
    expect(recent.map((i) => i.number)).toEqual([2, 4, 5]);
  });

  it("returns empty buckets for an empty list", () => {
    expect(partitionIssuesByPhase([])).toEqual({ active: [], recent: [] });
  });
});

describe("formatRelativeAge", () => {
  const now = "2026-06-14T12:00:00Z";
  const ago = (ms: number) => new Date(Date.parse(now) - ms).toISOString();

  it("says 'just now' under a minute", () => {
    expect(formatRelativeAge(ago(30_000), now)).toBe("just now");
  });
  it("reports minutes, hours, and days", () => {
    expect(formatRelativeAge(ago(5 * 60_000), now)).toBe("5m ago");
    expect(formatRelativeAge(ago(11 * 3_600_000), now)).toBe("11h ago");
    expect(formatRelativeAge(ago(3 * 86_400_000), now)).toBe("3d ago");
  });
  it("clamps a future timestamp (clock skew) to 'just now'", () => {
    expect(formatRelativeAge(ago(-60_000), now)).toBe("just now");
  });
  it("returns null for an unparseable timestamp", () => {
    expect(formatRelativeAge("nonsense", now)).toBeNull();
  });
});

describe("finishedRunAgeHint", () => {
  const now = "2026-06-14T12:00:00Z";
  const elevenHoursAgo = new Date(Date.parse(now) - 11 * 3_600_000).toISOString();

  it("shows the age for finished runs (done/stopped)", () => {
    expect(finishedRunAgeHint("done", elevenHoursAgo, now)).toBe("11h ago");
    expect(finishedRunAgeHint("stopped", elevenHoursAgo, now)).toBe("11h ago");
  });
  it("returns null for active runs (running/restarting)", () => {
    expect(finishedRunAgeHint("running", elevenHoursAgo, now)).toBeNull();
    expect(finishedRunAgeHint("restarting", elevenHoursAgo, now)).toBeNull();
  });
});

function historyEntry(
  number: number,
  phase: SandcastleStatusHistoryEntry["phase"],
  title = `Issue ${number}`,
): SandcastleStatusHistoryEntry {
  return { number, title, branch: `issue-${number}`, phase, completedAt: "2026-06-14T12:00:00Z" };
}

describe("historyLinksForPhase", () => {
  const id = identity({ owner: "acme", name: "widgets" });

  it("returns [] when history is undefined", () => {
    expect(historyLinksForPhase(undefined, "merged", id)).toEqual([]);
  });

  it("returns [] when history is empty", () => {
    expect(historyLinksForPhase([], "merged", id)).toEqual([]);
  });

  it("returns [] when no entries match the phase", () => {
    const hist = [historyEntry(1, "deferred"), historyEntry(2, "needs-human")];
    expect(historyLinksForPhase(hist, "merged", id)).toEqual([]);
  });

  it("filters to the requested phase only", () => {
    const hist = [
      historyEntry(1, "merged"),
      historyEntry(2, "deferred"),
      historyEntry(3, "merged"),
      historyEntry(4, "needs-human"),
    ];
    const rows = historyLinksForPhase(hist, "merged", id);
    expect(rows.map((r) => r.number)).toEqual([1, 3]);
  });

  it("preserves duplicates (same issue number appearing more than once)", () => {
    const hist = [historyEntry(7, "merged"), historyEntry(7, "merged")];
    const rows = historyLinksForPhase(hist, "merged", id);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.number).toBe(7);
    expect(rows[1]!.number).toBe(7);
  });

  it("builds correct GitHub href for a known identity", () => {
    const hist = [historyEntry(42, "merged")];
    const rows = historyLinksForPhase(hist, "merged", id);
    expect(rows[0]!.href).toBe("https://github.com/acme/widgets/issues/42");
    expect(rows[0]!.title).toBe("Issue 42");
  });

  it("produces null href when identity is null", () => {
    const hist = [historyEntry(5, "deferred")];
    const rows = historyLinksForPhase(hist, "deferred", null);
    expect(rows[0]!.href).toBeNull();
  });

  it("preserves original order", () => {
    const hist = [
      historyEntry(10, "needs-human"),
      historyEntry(3, "needs-human"),
      historyEntry(7, "needs-human"),
    ];
    const rows = historyLinksForPhase(hist, "needs-human", id);
    expect(rows.map((r) => r.number)).toEqual([10, 3, 7]);
  });
});

describe("recentFinishedIssues", () => {
  function snapshot(over: Partial<SandcastleStatusSnapshot>): SandcastleStatusSnapshot {
    return { ...runningSnapshot, ...over } as SandcastleStatusSnapshot;
  }
  function hist(
    number: number,
    phase: SandcastleStatusHistoryEntry["phase"],
    completedAt: string,
  ): SandcastleStatusHistoryEntry {
    return { number, title: `#${number}`, branch: `issue-${number}`, phase, completedAt };
  }

  it("returns history entries newest-first by completedAt", () => {
    const snap = snapshot({
      history: [
        hist(489, "needs-human", "2026-06-28T17:13:00Z"),
        hist(490, "merged", "2026-06-28T17:36:00Z"),
        hist(491, "merged", "2026-06-28T18:23:00Z"),
      ],
      issues: [issue(492, "implementer")],
    });
    expect(recentFinishedIssues(snap).map((r) => r.number)).toEqual([491, 490, 489]);
  });

  it("unions current-batch terminal issues not yet in history, sorting them to the top", () => {
    const snap = snapshot({
      history: [hist(490, "merged", "2026-06-28T17:36:00Z")],
      // 493 just finished this batch but isn't recorded to history yet.
      issues: [issue(492, "implementer"), issue(493, "merged")],
    });
    const rows = recentFinishedIssues(snap);
    expect(rows.map((r) => r.number)).toEqual([493, 490]);
    expect(rows[0]!.completedAt).toBeNull();
  });

  it("prefers the history entry over a duplicate current-batch terminal issue", () => {
    const snap = snapshot({
      history: [hist(490, "merged", "2026-06-28T17:36:00Z")],
      issues: [issue(490, "merged")],
    });
    const rows = recentFinishedIssues(snap);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.completedAt).toBe("2026-06-28T17:36:00Z");
  });

  it("excludes non-terminal current-batch issues", () => {
    const snap = snapshot({
      history: undefined,
      issues: [issue(1, "implementer"), issue(2, "merged"), issue(3, "reviewer")],
    });
    expect(recentFinishedIssues(snap).map((r) => r.number)).toEqual([2]);
  });

  it("falls back to current-batch terminal issues when history is absent", () => {
    const snap = snapshot({
      history: undefined,
      issues: [issue(2, "merged"), issue(4, "needs-human"), issue(5, "deferred")],
    });
    const rows = recentFinishedIssues(snap);
    expect(rows.map((r) => r.number)).toEqual([2, 4, 5]);
    expect(rows.every((r) => r.completedAt === null)).toBe(true);
  });

  it("returns [] when nothing has finished", () => {
    const snap = snapshot({ history: [], issues: [issue(492, "implementer")] });
    expect(recentFinishedIssues(snap)).toEqual([]);
  });
});

describe("queueReadyDisplay", () => {
  it("returns null when status is absent (repo isn't GitHub)", () => {
    expect(queueReadyDisplay(null)).toBeNull();
    expect(queueReadyDisplay(undefined)).toBeNull();
  });

  it("returns null while the first query is pending (count null, no error)", () => {
    expect(
      queueReadyDisplay({ count: null, label: "ready-for-agent", updatedAt: null, error: null }),
    ).toBeNull();
  });

  it("shows 'N of M ready' when fresh with a total", () => {
    const d = queueReadyDisplay({
      count: 4,
      total: 23,
      label: "ready-for-agent",
      updatedAt: "2026-06-28T18:00:00Z",
      error: null,
    });
    expect(d?.text).toBe("4 of 23 ready");
    expect(d?.muted).toBe(false);
  });

  it("falls back to 'N ready' when total is absent/null", () => {
    const dNull = queueReadyDisplay({
      count: 4,
      total: null,
      label: "ready-for-agent",
      updatedAt: "2026-06-28T18:00:00Z",
      error: null,
    });
    expect(dNull?.text).toBe("4 ready");
    expect(dNull?.muted).toBe(false);

    const dAbsent = queueReadyDisplay({
      count: 3,
      label: "ready-for-agent",
      updatedAt: "2026-06-28T18:00:00Z",
      error: null,
    });
    expect(dAbsent?.text).toBe("3 ready");
    expect(dAbsent?.muted).toBe(false);
  });

  it("shows zero plainly", () => {
    const d = queueReadyDisplay({
      count: 0,
      total: 5,
      label: "ready-for-agent",
      updatedAt: "2026-06-28T18:00:00Z",
      error: null,
    });
    expect(d?.text).toBe("0 of 5 ready");
    expect(d?.muted).toBe(false);
  });

  it("keeps the last count but mutes it when a refresh failed (stale)", () => {
    const d = queueReadyDisplay({
      count: 3,
      total: 8,
      label: "ready-for-agent",
      updatedAt: "2026-06-28T18:00:00Z",
      error: "gh-unauthed",
    });
    expect(d?.text).toBe("3 of 8 ready");
    expect(d?.muted).toBe(true);
  });

  it("shows 'queue unavailable' when a query failed with no prior count", () => {
    const d = queueReadyDisplay({
      count: null,
      label: "ready-for-agent",
      updatedAt: "2026-06-28T18:00:00Z",
      error: "gh-missing",
    });
    expect(d?.text).toBe("queue unavailable");
    expect(d?.muted).toBe(true);
  });
});
