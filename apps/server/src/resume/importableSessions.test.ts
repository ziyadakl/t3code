import { describe, expect, it } from "vitest";

import {
  buildImportedSessionMap,
  selectImportableSessions,
  type ImportedBinding,
  type SessionInfo,
} from "./importableSessions.ts";

/**
 * Inputs mirror the SDK's `listSessions({ dir })` result (`SDKSessionInfo`),
 * verified against real data 2026-06-04: `summary` is the auto title,
 * `customTitle` the user-set name (shown in Claude's own picker), `lastModified`
 * is ms since epoch. Origin is supplied separately from t3's DB.
 */
const session = (over: Partial<SessionInfo>): SessionInfo => ({
  sessionId: "s",
  summary: "Auto title",
  lastModified: 1780548498563,
  ...over,
});

describe("selectImportableSessions", () => {
  it("offers a terminal session, titled and not-yet-imported", () => {
    const result = selectImportableSessions(
      [session({ sessionId: "t1", summary: "Fix the bug" })],
      {
        t3OriginSessionIds: new Set(),
        importedSessions: new Map(),
      },
    );

    expect(result).toEqual([
      {
        sessionId: "t1",
        title: "Fix the bug",
        lastActivityAt: 1780548498563,
        alreadyImported: false,
      },
    ]);
  });

  it("prefers the user-set custom title over the auto summary", () => {
    const result = selectImportableSessions(
      [session({ sessionId: "t1", summary: "Auto", customTitle: "fork-polish" })],
      { t3OriginSessionIds: new Set(), importedSessions: new Map() },
    );

    expect(result[0]?.title).toBe("fork-polish");
  });

  it("hides sessions t3 created itself", () => {
    const result = selectImportableSessions(
      [session({ sessionId: "t1" }), session({ sessionId: "fromT3" })],
      { t3OriginSessionIds: new Set(["fromT3"]), importedSessions: new Map() },
    );

    expect(result.map((r) => r.sessionId)).toEqual(["t1"]);
  });

  it("flags an already-imported session and carries its existing thread id for rejoin", () => {
    const result = selectImportableSessions([session({ sessionId: "t1" })], {
      t3OriginSessionIds: new Set(),
      importedSessions: new Map([["t1", "thread-42"]]),
    });

    expect(result[0]?.alreadyImported).toBe(true);
    expect(result[0]?.existingThreadId).toBe("thread-42");
  });

  it("leaves existingThreadId undefined for a not-yet-imported session", () => {
    const result = selectImportableSessions([session({ sessionId: "t1" })], {
      t3OriginSessionIds: new Set(),
      importedSessions: new Map(),
    });

    expect(result[0]?.existingThreadId).toBeUndefined();
  });
});

const binding = (over: Partial<ImportedBinding>): ImportedBinding => ({
  threadId: "thread-1",
  resumeCursor: { resume: "sess-1" },
  lastSeenAt: "2026-06-01T00:00:00.000Z",
  ...over,
});

describe("buildImportedSessionMap", () => {
  it("maps a resumed session id to the thread that imported it", () => {
    const map = buildImportedSessionMap(
      [binding({ threadId: "thread-A", resumeCursor: { resume: "sess-A" } })],
      new Set(["thread-A"]),
    );

    expect(map.get("sess-A")).toBe("thread-A");
  });

  it("skips bindings with no string resume cursor (native t3 / other providers)", () => {
    const map = buildImportedSessionMap(
      [
        binding({ threadId: "native", resumeCursor: null }),
        binding({ threadId: "noResume", resumeCursor: { threadId: "x" } }),
        binding({ threadId: "blank", resumeCursor: { resume: "" } }),
      ],
      new Set(["native", "noResume", "blank"]),
    );

    expect(map.size).toBe(0);
  });

  it("lets the most-recently-active thread win when duplicates target one session", () => {
    const map = buildImportedSessionMap(
      [
        binding({
          threadId: "older",
          resumeCursor: { resume: "dup" },
          lastSeenAt: "2026-06-01T00:00:00.000Z",
        }),
        binding({
          threadId: "newer",
          resumeCursor: { resume: "dup" },
          lastSeenAt: "2026-06-09T00:00:00.000Z",
        }),
      ],
      new Set(["older", "newer"]),
    );

    expect(map.get("dup")).toBe("newer");
  });

  it("excludes a binding whose thread is no longer active (archived or deleted)", () => {
    const map = buildImportedSessionMap(
      [binding({ threadId: "archived-or-gone", resumeCursor: { resume: "sess-X" } })],
      new Set(),
    );

    expect(map.size).toBe(0);
  });
});
