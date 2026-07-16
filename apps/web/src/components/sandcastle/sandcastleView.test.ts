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
  groupSandcastleRows,
  sumTotalsAcrossHosts,
  perMachineIterations,
  formatPerMachineIterations,
  hostBadgeLabel,
  unionActiveIssuesByHost,
  mergedRecentAcrossHosts,
  hostsOf,
  STALE_AFTER_MS,
  type SandcastleGroupItem,
} from "./sandcastleView.ts";
import type {
  PeerStatus,
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

describe("groupSandcastleRows", () => {
  function row(
    id: string,
    state: SandcastleGroupItem<string>["state"],
    updatedAt: string | null,
  ): SandcastleGroupItem<string> {
    return { item: id, state, updatedAt };
  }

  it("returns empty groups for empty input", () => {
    const g = groupSandcastleRows<string>([]);
    expect(g.running).toEqual([]);
    expect(g.idle).toEqual([]);
  });

  it("sorts an all-running set most-recent first", () => {
    const g = groupSandcastleRows([
      row("a", "running", "2026-06-01T00:00:00Z"),
      row("b", "running", "2026-06-03T00:00:00Z"),
      row("c", "restarting", "2026-06-02T00:00:00Z"),
    ]);
    expect(g.running).toEqual(["b", "c", "a"]);
    expect(g.idle).toEqual([]);
  });

  it("sorts an all-idle set most-recent first", () => {
    const g = groupSandcastleRows([
      row("a", "done", "2026-06-01T00:00:00Z"),
      row("b", "stopped", "2026-06-03T00:00:00Z"),
      row("c", "unhealthy", "2026-06-02T00:00:00Z"),
    ]);
    expect(g.idle).toEqual(["b", "c", "a"]);
    expect(g.running).toEqual([]);
  });

  it("splits a mixed set and sorts each group desc", () => {
    const g = groupSandcastleRows([
      row("run-old", "running", "2026-06-01T00:00:00Z"),
      row("idle-new", "done", "2026-06-05T00:00:00Z"),
      row("run-new", "restarting", "2026-06-04T00:00:00Z"),
      row("idle-old", "stopped", "2026-06-02T00:00:00Z"),
    ]);
    expect(g.running).toEqual(["run-new", "run-old"]);
    expect(g.idle).toEqual(["idle-new", "idle-old"]);
  });

  it("sorts rows with null updatedAt to the end, keeping input order among them", () => {
    const g = groupSandcastleRows([
      row("no-ts-1", "done", null),
      row("has-ts", "done", "2026-06-02T00:00:00Z"),
      row("no-ts-2", "done", null),
    ]);
    expect(g.idle).toEqual(["has-ts", "no-ts-1", "no-ts-2"]);
  });

  it("sorts unparseable updatedAt to the end like null", () => {
    const g = groupSandcastleRows([
      row("bad", "done", "not-a-date"),
      row("good", "done", "2026-06-02T00:00:00Z"),
    ]);
    expect(g.idle).toEqual(["good", "bad"]);
  });

  it("treats a null state as idle", () => {
    const g = groupSandcastleRows([row("no-run", null, null)]);
    expect(g.idle).toEqual(["no-run"]);
    expect(g.running).toEqual([]);
  });

  it("classifies running and restarting as running", () => {
    const g = groupSandcastleRows([
      row("r1", "running", "2026-06-01T00:00:00Z"),
      row("r2", "restarting", "2026-06-01T00:00:00Z"),
    ]);
    expect(new Set(g.running)).toEqual(new Set(["r1", "r2"]));
    expect(g.idle).toEqual([]);
  });

  it("classifies done, stopped and unhealthy as idle", () => {
    const g = groupSandcastleRows([
      row("d", "done", "2026-06-01T00:00:00Z"),
      row("s", "stopped", "2026-06-01T00:00:00Z"),
      row("u", "unhealthy", "2026-06-01T00:00:00Z"),
    ]);
    expect(g.running).toEqual([]);
    expect(new Set(g.idle)).toEqual(new Set(["d", "s", "u"]));
  });

  it("keeps stable input order for equal timestamps", () => {
    const ts = "2026-06-01T00:00:00Z";
    const g = groupSandcastleRows([
      row("first", "running", ts),
      row("second", "running", ts),
      row("third", "running", ts),
    ]);
    expect(g.running).toEqual(["first", "second", "third"]);
  });
});

// --- cross-host fusion helpers (schema v3) ---------------------------------

/** A snapshot builder that also carries the v3 cross-host fields. */
function xSnapshot(over: Partial<SandcastleStatusSnapshot>): SandcastleStatusSnapshot {
  return { ...runningSnapshot, ...over } as SandcastleStatusSnapshot;
}

function peer(over: Partial<PeerStatus> & Pick<PeerStatus, "hostId">): PeerStatus {
  return {
    state: "running",
    iterations: { current: 1, total: 9 },
    totals: { merged: 0, needsHuman: 0, requeued: 0, running: 1 },
    issues: [],
    updatedAt: "2026-06-04T12:00:00.000Z",
    ...over,
  };
}

function xHist(
  number: number,
  phase: SandcastleStatusHistoryEntry["phase"],
  completedAt: string,
): SandcastleStatusHistoryEntry {
  return { number, title: `#${number}`, branch: `issue-${number}`, phase, completedAt };
}

describe("hostBadgeLabel", () => {
  it("title-cases a hyphenated hostId", () => {
    expect(hostBadgeLabel("ziyads-macbook-air")).toBe("Ziyads Macbook Air");
  });
  it("upcases a single short word", () => {
    expect(hostBadgeLabel("vps")).toBe("Vps");
  });
  it("preserves an already-capitalized word", () => {
    expect(hostBadgeLabel("Mac")).toBe("Mac");
  });
  it("splits on underscores and dots too", () => {
    expect(hostBadgeLabel("build_box.local")).toBe("Build Box Local");
  });
  it("trims surrounding whitespace", () => {
    expect(hostBadgeLabel("  vps  ")).toBe("Vps");
  });
  it("returns empty string for empty/whitespace input", () => {
    expect(hostBadgeLabel("")).toBe("");
    expect(hostBadgeLabel("   ")).toBe("");
  });
});

describe("hostsOf", () => {
  it("yields the own host first, then each peer in order", () => {
    const snap = xSnapshot({
      hostId: "mac",
      peers: [peer({ hostId: "vps" }), peer({ hostId: "pi" })],
    });
    expect([...hostsOf(snap)].map((h) => h.hostId)).toEqual(["mac", "vps", "pi"]);
  });

  it("maps own fields: iterations from snap.run.iterations, history from snap.history", () => {
    const snap = xSnapshot({
      hostId: "mac",
      run: { ...runningSnapshot.run, iterations: { current: 3, total: 8 } },
      history: [xHist(491, "merged", "2026-06-28T18:23:00Z")],
      totals: { merged: 2, needsHuman: 1, requeued: 0, running: 1 },
      issues: [issue(1, "implementer")],
      updatedAt: "2026-06-28T18:23:00Z",
    });
    const own = [...hostsOf(snap)][0]!;
    expect(own).toEqual({
      hostId: "mac",
      issues: [issue(1, "implementer")],
      history: [xHist(491, "merged", "2026-06-28T18:23:00Z")],
      totals: { merged: 2, needsHuman: 1, requeued: 0, running: 1 },
      iterations: { current: 3, total: 8 },
      updatedAt: "2026-06-28T18:23:00Z",
    });
  });

  it("maps peer fields from the peer, with history undefined", () => {
    const snap = xSnapshot({
      hostId: "mac",
      peers: [
        peer({
          hostId: "vps",
          iterations: { current: 5, total: 8 },
          totals: { merged: 3, needsHuman: 0, requeued: 2, running: 1 },
          issues: [issue(700, "merged")],
          updatedAt: "2026-07-01T00:00:00.000Z",
        }),
      ],
    });
    const p = [...hostsOf(snap)][1]!;
    expect(p).toEqual({
      hostId: "vps",
      issues: [issue(700, "merged")],
      history: undefined,
      totals: { merged: 3, needsHuman: 0, requeued: 2, running: 1 },
      iterations: { current: 5, total: 8 },
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
  });

  it("v2 no-peers snapshot yields only the own host (iterations from snap.run.iterations)", () => {
    const snap = xSnapshot({
      run: { ...runningSnapshot.run, iterations: { current: 3, total: 8 } },
    });
    const slices = [...hostsOf(snap)];
    expect(slices).toHaveLength(1);
    expect(slices[0]!.hostId).toBeUndefined();
    expect(slices[0]!.iterations).toEqual({ current: 3, total: 8 });
  });
});

describe("sumTotalsAcrossHosts", () => {
  it("field-wise sums own totals with each peer's totals", () => {
    const snap = xSnapshot({
      totals: { merged: 2, needsHuman: 1, requeued: 0, running: 1 },
      hostId: "mac",
      peers: [
        peer({ hostId: "vps", totals: { merged: 3, needsHuman: 0, requeued: 2, running: 1 } }),
        peer({ hostId: "pi", totals: { merged: 1, needsHuman: 1, requeued: 1, running: 0 } }),
      ],
    });
    expect(sumTotalsAcrossHosts(snap)).toEqual({
      merged: 6,
      needsHuman: 2,
      requeued: 3,
      running: 2,
    });
  });

  it("returns own totals unchanged when peers is absent", () => {
    const snap = xSnapshot({ totals: { merged: 5, needsHuman: 1, requeued: 2, running: 3 } });
    expect(sumTotalsAcrossHosts(snap)).toEqual({
      merged: 5,
      needsHuman: 1,
      requeued: 2,
      running: 3,
    });
  });

  it("returns own totals unchanged when peers is empty", () => {
    const snap = xSnapshot({
      totals: { merged: 5, needsHuman: 1, requeued: 2, running: 3 },
      peers: [],
    });
    expect(sumTotalsAcrossHosts(snap)).toEqual({
      merged: 5,
      needsHuman: 1,
      requeued: 2,
      running: 3,
    });
  });
});

describe("perMachineIterations", () => {
  it("lists own first, then one entry per peer", () => {
    const snap = xSnapshot({
      hostId: "mac",
      run: { ...runningSnapshot.run, iterations: { current: 3, total: 8 } },
      peers: [
        peer({ hostId: "vps", iterations: { current: 5, total: 8 } }),
        peer({ hostId: "pi", iterations: { current: 2, total: 8 } }),
      ],
    });
    expect(perMachineIterations(snap)).toEqual([
      { hostId: "mac", current: 3, total: 8 },
      { hostId: "vps", current: 5, total: 8 },
      { hostId: "pi", current: 2, total: 8 },
    ]);
  });

  it("returns a single own entry when there are no peers", () => {
    const snap = xSnapshot({
      hostId: "mac",
      run: { ...runningSnapshot.run, iterations: { current: 3, total: 8 } },
    });
    expect(perMachineIterations(snap)).toEqual([{ hostId: "mac", current: 3, total: 8 }]);
  });
});

describe("formatPerMachineIterations", () => {
  it("labels each machine when there are peers", () => {
    const snap = xSnapshot({
      hostId: "mac",
      run: { ...runningSnapshot.run, iterations: { current: 3, total: 8 } },
      peers: [peer({ hostId: "vps", iterations: { current: 5, total: 8 } })],
    });
    expect(formatPerMachineIterations(snap)).toBe("Mac 3/8 · Vps 5/8");
  });

  it("omits the host label for a single machine (no peers)", () => {
    const snap = xSnapshot({
      hostId: "mac",
      run: { ...runningSnapshot.run, iterations: { current: 3, total: 8 } },
    });
    expect(formatPerMachineIterations(snap)).toBe("3/8");
  });
});

describe("unionActiveIssuesByHost", () => {
  it("tags own active issues then each peer's active issues", () => {
    const snap = xSnapshot({
      hostId: "mac",
      issues: [issue(1, "implementer"), issue(2, "merged"), issue(3, "reviewer")],
      peers: [peer({ hostId: "vps", issues: [issue(10, "implementer"), issue(11, "merged")] })],
    });
    expect(unionActiveIssuesByHost(snap)).toEqual([
      { issue: issue(1, "implementer"), hostId: "mac" },
      { issue: issue(3, "reviewer"), hostId: "mac" },
      { issue: issue(10, "implementer"), hostId: "vps" },
    ]);
  });
});

describe("mergedRecentAcrossHosts", () => {
  it("combines own and peer finished rows, newest-first, tagged by host", () => {
    const snap = xSnapshot({
      hostId: "mac",
      history: [
        xHist(489, "needs-human", "2026-06-28T17:13:00Z"),
        xHist(491, "merged", "2026-06-28T18:23:00Z"),
      ],
      issues: [issue(492, "implementer")],
      peers: [
        peer({
          hostId: "vps",
          // A peer has no per-issue history; its terminal issues take the peer
          // snapshot's `updatedAt` (default 2026-06-04) as their completion time.
          issues: [issue(700, "merged"), issue(701, "reviewer")],
        }),
      ],
    });
    const rows = mergedRecentAcrossHosts(snap);
    // 491 (Jun 28 18:23) > 489 (Jun 28 17:13) > 700 (peer updatedAt Jun 04).
    expect(rows.map((r) => ({ number: r.number, hostId: r.hostId }))).toEqual([
      { number: 491, hostId: "mac" },
      { number: 489, hostId: "mac" },
      { number: 700, hostId: "vps" },
    ]);
    // The peer row is timestamped from the peer snapshot, not null.
    expect(rows.find((r) => r.number === 700)!.completedAt).toBe("2026-06-04T12:00:00.000Z");
  });
});

describe("mergedRecentAcrossHosts — cross-host Recent finished fusion (regressions)", () => {
  // BUG #2 (wrong-host label): the FUSED status.json foldPeers writes has a
  // top-level `history` containing PEER-completed rows carrying their own
  // e.hostId. The history branch of finishedRowsFromIssues must honor e.hostId,
  // not tag every row with the PARAM (own) hostId.
  it("preserves per-entry hostId for peer rows fused into top-level history", () => {
    const snap = xSnapshot({
      hostId: "mac",
      // As produced by foldPeers: own row (mac) + a peer row (vps) both live in
      // the top-level history, each carrying e.hostId.
      history: [
        { ...xHist(491, "merged", "2026-06-28T18:23:00Z"), hostId: "mac" },
        { ...xHist(700, "merged", "2026-06-28T18:20:00Z"), hostId: "vps" },
      ],
      issues: [],
    });
    const rows = mergedRecentAcrossHosts(snap);
    // The field's documented meaning is "the host that completed this issue".
    expect(rows.find((r) => r.number === 700)!.hostId).toBe("vps");
    expect(rows.find((r) => r.number === 491)!.hostId).toBe("mac");
  });

  // BUG #3 (undated peer rows sort to top): peer rows previously got
  // completedAt=null, which byCompletedAtDesc sorts FIRST; the consuming
  // component (SandcastleProjectDetail RECENT_LIMIT=10) slices, so a
  // genuinely-recent own-host merge was pushed below the fold behind peer rows.
  // Peer rows must take the peer snapshot's `updatedAt` as an honest timestamp.
  it("keeps a fresh own-host merge on screen instead of behind undated peer rows", () => {
    const RECENT_LIMIT = 10; // mirror of SandcastleProjectDetail.tsx
    const snap = xSnapshot({
      hostId: "mac",
      // One genuinely-recent own merge, logged to history.
      history: [{ ...xHist(999, "merged", "2026-06-28T23:59:00Z"), hostId: "mac" }],
      issues: [],
      peers: [
        peer({
          hostId: "vps",
          // A stale peer snapshot: 10 current-batch terminal issues, all taking
          // the peer's older updatedAt as their completion time.
          updatedAt: "2026-06-01T00:00:00.000Z",
          issues: Array.from({ length: 10 }, (_, k) => issue(100 + k, "merged")),
        }),
      ],
    });
    const shown = mergedRecentAcrossHosts(snap).slice(0, RECENT_LIMIT);
    // The fresh own-host merge (Jun 28) sorts above the stale peer rows (Jun 01)
    // and stays on screen, not shoved off by them.
    expect(shown[0]!.number).toBe(999);
    expect(shown.some((r) => r.number === 999)).toBe(true);
  });

  // BUG #4 (peer-merged issue double-emitted): recordOutcome sets phase=merged
  // in place AND pushes to top-level history (tagged with the peer hostId via
  // foldPeers). So a peer-merged issue #N lands SIMULTANEOUSLY in top-level
  // `history` (real completedAt) and in `peers[].issues` (phase "merged"). The
  // own-call emits #N from history; the peer-call emits #N again from p.issues
  // with the fallback (peer updatedAt) timestamp. The `seen` Set is local per
  // call, so there was no cross-call dedup → #N appeared twice in Recent.
  it("dedups a peer-merged issue present in BOTH top-level history and peer issues", () => {
    const snap = xSnapshot({
      hostId: "mac",
      // foldPeers put #700 (completed by vps) into the fused top-level history.
      history: [{ ...xHist(700, "merged", "2026-06-28T18:20:00Z"), hostId: "vps" }],
      issues: [],
      peers: [
        peer({
          hostId: "vps",
          // recordOutcome also set #700 phase=merged in place on the peer.
          updatedAt: "2026-06-04T12:00:00.000Z",
          issues: [issue(700, "merged")],
        }),
      ],
    });
    const rows = mergedRecentAcrossHosts(snap);
    const sevenHundreds = rows.filter((r) => r.number === 700);
    expect(sevenHundreds).toHaveLength(1);
    // The kept row is the history one: real completedAt + the completing host.
    expect(sevenHundreds[0]!.completedAt).toBe("2026-06-28T18:20:00Z");
    expect(sevenHundreds[0]!.hostId).toBe("vps");
  });

  // Guard against over-dedup: a peer issue that is NOT in top-level history must
  // still appear (it's the only source for that issue).
  it("still emits a peer issue that is absent from top-level history (no over-dedup)", () => {
    const snap = xSnapshot({
      hostId: "mac",
      history: [{ ...xHist(700, "merged", "2026-06-28T18:20:00Z"), hostId: "vps" }],
      issues: [],
      peers: [
        peer({
          hostId: "vps",
          updatedAt: "2026-06-04T12:00:00.000Z",
          // #700 is a duplicate of history; #701 is peer-only.
          issues: [issue(700, "merged"), issue(701, "merged")],
        }),
      ],
    });
    const rows = mergedRecentAcrossHosts(snap);
    expect(rows.filter((r) => r.number === 700)).toHaveLength(1);
    const peerOnly = rows.filter((r) => r.number === 701);
    expect(peerOnly).toHaveLength(1);
    expect(peerOnly[0]!.hostId).toBe("vps");
    expect(peerOnly[0]!.completedAt).toBe("2026-06-04T12:00:00.000Z");
  });
});

describe("cross-host helpers degrade to single-host output (v2 file: no peers, no hostId)", () => {
  const v2 = xSnapshot({
    run: { ...runningSnapshot.run, iterations: { current: 3, total: 8 } },
    totals: { merged: 4, needsHuman: 1, requeued: 2, running: 1 },
    history: [
      xHist(489, "needs-human", "2026-06-28T17:13:00Z"),
      xHist(491, "merged", "2026-06-28T18:23:00Z"),
    ],
    issues: [issue(492, "implementer"), issue(493, "merged")],
  });

  it("sumTotalsAcrossHosts equals snap.totals", () => {
    expect(sumTotalsAcrossHosts(v2)).toEqual(v2.totals);
  });

  it("perMachineIterations is one entry with undefined hostId", () => {
    expect(perMachineIterations(v2)).toEqual([{ hostId: undefined, current: 3, total: 8 }]);
  });

  it("formatPerMachineIterations is plain c/t with no label", () => {
    expect(formatPerMachineIterations(v2)).toBe("3/8");
  });

  it("unionActiveIssuesByHost is own active issues with undefined hostId", () => {
    expect(unionActiveIssuesByHost(v2)).toEqual([
      { issue: issue(492, "implementer"), hostId: undefined },
    ]);
  });

  it("mergedRecentAcrossHosts matches recentFinishedIssues rows/order (plus undefined hostId)", () => {
    const merged = mergedRecentAcrossHosts(v2);
    const own = recentFinishedIssues(v2);
    expect(merged.map((r) => ({ number: r.number, completedAt: r.completedAt }))).toEqual(
      own.map((r) => ({ number: r.number, completedAt: r.completedAt })),
    );
    expect(merged.every((r) => r.hostId === undefined)).toBe(true);
  });
});
