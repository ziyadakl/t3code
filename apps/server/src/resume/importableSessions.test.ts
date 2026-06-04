import { describe, expect, it } from "vitest";

import { selectImportableSessions, type SessionInfo } from "./importableSessions.ts";

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
        importedSessionIds: new Set(),
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
      { t3OriginSessionIds: new Set(), importedSessionIds: new Set() },
    );

    expect(result[0]?.title).toBe("fork-polish");
  });

  it("hides sessions t3 created itself", () => {
    const result = selectImportableSessions(
      [session({ sessionId: "t1" }), session({ sessionId: "fromT3" })],
      { t3OriginSessionIds: new Set(["fromT3"]), importedSessionIds: new Set() },
    );

    expect(result.map((r) => r.sessionId)).toEqual(["t1"]);
  });

  it("flags a terminal session already imported into a Thread", () => {
    const result = selectImportableSessions([session({ sessionId: "t1" })], {
      t3OriginSessionIds: new Set(),
      importedSessionIds: new Set(["t1"]),
    });

    expect(result[0]?.alreadyImported).toBe(true);
  });
});
