import { describe, it, expect } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  SandcastleStatusSnapshot,
  SandcastleStatusHistoryEntry,
  PeerStatus,
  SANDCASTLE_STATUS_SCHEMA_VERSION,
} from "./sandcastle.ts";

const decodeSnapshot = Schema.decodeUnknownSync(SandcastleStatusSnapshot);
const decodeHistoryEntry = Schema.decodeUnknownSync(SandcastleStatusHistoryEntry);
const decodePeer = Schema.decodeUnknownSync(PeerStatus);

const ONE_PEER = {
  hostId: "host-b",
  state: "running",
  activity: "reviewing",
  iterations: { current: 3, total: 20 },
  totals: { merged: 2, needsHuman: 0, requeued: 1, running: 1 },
  issues: [
    {
      number: 401,
      title: "peer issue",
      branch: "agent/issue-401",
      phase: "reviewer",
    },
  ],
  updatedAt: "2026-07-14T10:00:00.000Z",
};

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
    const decoded = decodeSnapshot(SAMPLE);
    expect(decoded.state).toBe("running");
    expect(decoded.issues).toHaveLength(2);
    expect(decoded.issues[1]?.phase).toBe("merged");
    expect(decoded.totals.needsHuman).toBe(1);
  });

  it("decodes a snapshot with no issues and no activity", () => {
    const decoded = decodeSnapshot({
      ...SAMPLE,
      issues: [],
      activity: undefined,
    });
    expect(decoded.issues).toHaveLength(0);
  });

  it("rejects an unknown phase value", () => {
    expect(() =>
      decodeSnapshot({
        ...SAMPLE,
        issues: [{ number: 1, title: "x", branch: "b", phase: "bogus-phase" }],
      }),
    ).toThrow();
  });

  it("pins the highest readable schema version to 3", () => {
    expect(SANDCASTLE_STATUS_SCHEMA_VERSION).toBe(3);
  });

  it("decodes a snapshot with NO hostId/runId/peers (v2 back-compat)", () => {
    // SAMPLE carries none of the cross-host fields — old files must still decode
    const decoded = decodeSnapshot(SAMPLE);
    expect(decoded.hostId).toBeUndefined();
    expect(decoded.runId).toBeUndefined();
    expect(decoded.peers).toBeUndefined();
  });

  it("decodes a v3 snapshot with hostId/runId/peers and round-trips them", () => {
    const decoded = decodeSnapshot({
      ...SAMPLE,
      schemaVersion: 3,
      hostId: "host-a",
      runId: "run-2026-07-14",
      peers: [ONE_PEER],
    });
    expect(decoded.hostId).toBe("host-a");
    expect(decoded.runId).toBe("run-2026-07-14");
    expect(decoded.peers).toHaveLength(1);
    expect(decoded.peers?.[0]?.hostId).toBe("host-b");
    expect(decoded.peers?.[0]?.state).toBe("running");
    expect(decoded.peers?.[0]?.iterations.current).toBe(3);
    expect(decoded.peers?.[0]?.totals.merged).toBe(2);
    expect(decoded.peers?.[0]?.issues[0]?.number).toBe(401);
    expect(decoded.peers?.[0]?.updatedAt).toBe("2026-07-14T10:00:00.000Z");
  });

  it("decodes a v2 snapshot with the terminal 'unhealthy' state", () => {
    const decoded = decodeSnapshot({ ...SAMPLE, schemaVersion: 2, state: "unhealthy" });
    expect(decoded.state).toBe("unhealthy");
  });

  it("decodes a snapshot without history (backward compat)", () => {
    // SAMPLE has no `history` key — old runs must still decode
    const decoded = decodeSnapshot(SAMPLE);
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
    const decoded = decodeSnapshot(withHistory);
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
      decodeSnapshot({
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
    const decoded = decodeHistoryEntry({
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

  it("decodes a history entry WITH a hostId (cross-host v3)", () => {
    const decoded = decodeHistoryEntry({
      number: 43,
      title: "host-tagged entry",
      branch: "agent/issue-43",
      phase: "merged",
      completedAt: "2026-07-14T10:00:00.000Z",
      hostId: "host-b",
    });
    expect(decoded.hostId).toBe("host-b");
  });

  it("decodes a history entry WITHOUT a hostId (back-compat)", () => {
    const decoded = decodeHistoryEntry({
      number: 44,
      title: "untagged entry",
      branch: "agent/issue-44",
      phase: "merged",
      completedAt: "2026-07-14T10:00:00.000Z",
    });
    expect(decoded.hostId).toBeUndefined();
  });
});

describe("PeerStatus", () => {
  it("decodes a standalone PeerStatus fixture", () => {
    const decoded = decodePeer(ONE_PEER);
    expect(decoded.hostId).toBe("host-b");
    expect(decoded.state).toBe("running");
    expect(decoded.activity).toBe("reviewing");
    expect(decoded.iterations.total).toBe(20);
    expect(decoded.totals.requeued).toBe(1);
    expect(decoded.issues).toHaveLength(1);
    expect(decoded.issues[0]?.phase).toBe("reviewer");
    expect(decoded.updatedAt).toBe("2026-07-14T10:00:00.000Z");
  });

  it("decodes a PeerStatus with no activity (optional)", () => {
    const decoded = decodePeer({ ...ONE_PEER, activity: undefined });
    expect(decoded.activity).toBeUndefined();
  });
});
