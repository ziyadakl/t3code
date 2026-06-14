// apps/web/src/components/sandcastle/sandcastleView.test.ts
import { describe, it, expect } from "vitest";
import {
  deriveBanner,
  isStale,
  githubIssueUrl,
  phaseLabel,
  STALE_AFTER_MS,
} from "./sandcastleView.ts";
import type { SandcastleStatusEntry } from "@t3tools/contracts";

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
      githubIssueUrl({ owner: "acme", name: "widgets" } as never, 42),
    ).toBe("https://github.com/acme/widgets/issues/42");
  });
  it("falls back to remoteUrl parsing", () => {
    expect(
      githubIssueUrl(
        { locator: { remoteUrl: "git@github.com:acme/widgets.git" } } as never,
        7,
      ),
    ).toBe("https://github.com/acme/widgets/issues/7");
  });
  it("returns null when nothing usable", () => {
    expect(githubIssueUrl(null, 1)).toBeNull();
    expect(githubIssueUrl({} as never, 1)).toBeNull();
  });
});

describe("phaseLabel", () => {
  it("humanizes phases", () => {
    expect(phaseLabel("implementer-retry")).toBe("Retry");
    expect(phaseLabel("needs-human")).toBe("Needs you");
    expect(phaseLabel("merged")).toBe("Merged");
  });
});
