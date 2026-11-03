import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { filterSharedServerPatch } from "./sharedSettings.ts";

describe("filterSharedServerPatch", () => {
  it("shares the auto-archive threshold only with servers that report it", () => {
    const patch = { sidebarAutoArchiveSettledAfterDays: 14, sidebarAutoSettleAfterDays: 7 };
    expect(filterSharedServerPatch(patch, DEFAULT_SERVER_SETTINGS)).toEqual(patch);
    expect(filterSharedServerPatch(patch, undefined)).toEqual({ sidebarAutoSettleAfterDays: 7 });
    const { sidebarAutoArchiveSettledAfterDays: _omitted, ...oldServer } = DEFAULT_SERVER_SETTINGS;
    expect(filterSharedServerPatch(patch, oldServer as typeof DEFAULT_SERVER_SETTINGS)).toEqual({
      sidebarAutoSettleAfterDays: 7,
    });
  });
});
