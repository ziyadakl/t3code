import { describe, it, expect } from "vitest";
import * as Schema from "effect/Schema";
import {
  SandcastleStatusSnapshot,
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
});
