// apps/web/src/components/sandcastle/sandcastleView.test.ts
import { describe, it, expect } from "vite-plus/test";
import {
  deriveBanner,
  isStale,
  githubIssueUrl,
  phaseLabel,
  partitionIssuesByPhase,
  formatRelativeAge,
  finishedRunAgeHint,
  STALE_AFTER_MS,
} from "./sandcastleView.ts";
import type {
  RepositoryIdentity,
  SandcastleStatusEntry,
  SandcastleStatusIssue,
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
  run: { branch: "b", repo: "r", startedAt: "x", iterations: { current: 1, total: 9 }, maxConcurrent: 1 },
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
    const now = new Date(Date.parse(runningSnapshot.updatedAt) + STALE_AFTER_MS + 1000).toISOString();
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
    const late = new Date(Date.parse(runningSnapshot.updatedAt) + STALE_AFTER_MS + 1000).toISOString();
    expect(deriveBanner(entry({ snapshot: runningSnapshot }), late).kind).toBe("stale");
  });
  it("done state", () => {
    expect(deriveBanner(entry({ snapshot: { ...runningSnapshot, state: "done" } }), now).kind).toBe("done");
  });
  it("stopped state", () => {
    expect(deriveBanner(entry({ snapshot: { ...runningSnapshot, state: "stopped" } }), now).kind).toBe("stopped");
  });
});

describe("githubIssueUrl", () => {
  it("builds from owner+name", () => {
    expect(
      githubIssueUrl(identity({ owner: "acme", name: "widgets" }), 42),
    ).toBe("https://github.com/acme/widgets/issues/42");
  });
  it("falls back to remoteUrl parsing", () => {
    expect(
      githubIssueUrl(
        identity({ remoteUrl: "git@github.com:acme/widgets.git" }),
        7,
      ),
    ).toBe("https://github.com/acme/widgets/issues/7");
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

function issue(
  number: number,
  phase: SandcastleStatusIssue["phase"],
): SandcastleStatusIssue {
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
