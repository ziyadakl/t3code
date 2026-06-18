import { describe, it, expect } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  SandcastleStatusSnapshot,
  SandcastleStatusHistoryEntry,
  SANDCASTLE_STATUS_SCHEMA_VERSION,
} from "./sandcastle.ts";

const SAMPLE = {
  schemaVersion: 1,
  state: "running",
  run: {
    branch: "sandcastle/run-jun4",
    repo: "affinity-tracker",
    startedAt: "2026-06-04T12:00:00.000Z",
    iterations: { current: 1, total: 50 },
    maxConcurrent: 2,
  },
  totals: { merged: 1, needsHuman: 1, requeued: 0, running: 1 },
  issues: [
    {
      number: 337,
      title: "backfilled txns uncategorized",
      branch: "agent/issue-337",
      phase: "implementer",
      startedAt: "2026-06-04T12:05:30.000Z",
    },
    {
      number: 339,
      title: "scope setUserEnabled to team",
      branch: "agent/issue-339",
      phase: "merged",
      detail: "ALL_CLEAR",
      startedAt: "2026-06-04T12:00:15.000Z",
      attention: false,
    },
  ],
  updatedAt: "2026-06-04T12:06:45.000Z",
  activity: "merging",
};

describe("SandcastleStatusSnapshot", () => {
  it("decodes a representative status.json", () => {
    const decoded = Schema.decodeUnknownSync(SandcastleStatusSnapshot)(SAMPLE);
    expect(decoded.state).toBe("running");
    expect(decoded.issues).toHaveLength(2);
    expect(decoded.issues[1]?.phase).toBe("merged");
    expect(decoded.totals.needsHuman).toBe(1);
  });

  it("decodes a snapshot with no issues and no activity", () => {
    const decoded = Schema.decodeUnknownSync(SandcastleStatusSnapshot)({
      ...SAMPLE,
      issues: [],
      activity: undefined,
    });
    expect(decoded.issues).toHaveLength(0);
  });

  it("rejects an unknown phase value", () => {
    expect(() =>
      Schema.decodeUnknownSync(SandcastleStatusSnapshot)({
        ...SAMPLE,
        issues: [{ number: 1, title: "x", branch: "b", phase: "bogus-phase" }],
      }),
    ).toThrow();
  });

  it("pins the known schema version to 1", () => {
    expect(SANDCASTLE_STATUS_SCHEMA_VERSION).toBe(1);
  });

  it("decodes a snapshot without history (backward compat)", () => {
    // SAMPLE has no `history` key — old runs must still decode
    const decoded = Schema.decodeUnknownSync(SandcastleStatusSnapshot)(SAMPLE);
    expect(decoded.history).toBeUndefined();
  });

  it("decodes a snapshot with a history array", () => {
    const withHistory = {
      ...SAMPLE,
      history: [
        {
          number: 337,
          title: "backfilled txns uncategorized",
          branch: "agent/issue-337",
          phase: "merged",
          completedAt: "2026-06-04T13:00:00.000Z",
        },
        {
          number: 339,
          title: "scope setUserEnabled to team",
          branch: "agent/issue-339",
          phase: "needs-human",
          completedAt: "2026-06-04T13:15:00.000Z",
        },
        {
          number: 340,
          title: "retry deferred issue",
          branch: "agent/issue-340",
          phase: "deferred",
          completedAt: "2026-06-04T14:00:00.000Z",
        },
        // same number as first entry — duplicates must be allowed
        {
          number: 337,
          title: "backfilled txns uncategorized (retry)",
          branch: "agent/issue-337",
          phase: "needs-human",
          completedAt: "2026-06-05T09:00:00.000Z",
        },
      ],
    };
    const decoded = Schema.decodeUnknownSync(SandcastleStatusSnapshot)(withHistory);
    expect(decoded.history).toHaveLength(4);
    expect(decoded.history?.[0]?.number).toBe(337);
    expect(decoded.history?.[0]?.title).toBe("backfilled txns uncategorized");
    expect(decoded.history?.[0]?.branch).toBe("agent/issue-337");
    expect(decoded.history?.[0]?.phase).toBe("merged");
    expect(decoded.history?.[0]?.completedAt).toBe("2026-06-04T13:00:00.000Z");
    expect(decoded.history?.[1]?.phase).toBe("needs-human");
    expect(decoded.history?.[2]?.phase).toBe("deferred");
    // both entries with number 337 survive (no dedup)
    expect(decoded.history?.filter((e) => e.number === 337)).toHaveLength(2);
  });

  it("rejects a history entry with a bogus phase", () => {
    expect(() =>
      Schema.decodeUnknownSync(SandcastleStatusSnapshot)({
        ...SAMPLE,
        history: [
          {
            number: 1,
            title: "x",
            branch: "b",
            phase: "bogus-phase",
            completedAt: "2026-06-04T13:00:00.000Z",
          },
        ],
      }),
    ).toThrow();
  });
});

describe("SandcastleStatusHistoryEntry", () => {
  it("is a standalone decodable schema (exported for consumers)", () => {
    const decoded = Schema.decodeUnknownSync(SandcastleStatusHistoryEntry)({
      number: 42,
      title: "standalone entry",
      branch: "agent/issue-42",
      phase: "merged",
      completedAt: "2026-06-10T10:00:00.000Z",
    });
    expect(decoded.number).toBe(42);
    expect(decoded.phase).toBe("merged");
    expect(decoded.completedAt).toBe("2026-06-10T10:00:00.000Z");
  });
});
