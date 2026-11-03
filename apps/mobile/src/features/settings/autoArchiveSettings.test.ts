import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { planAutoSettleAndArchiveSync } from "./autoArchiveSettings";

const reference = {
  environmentId: EnvironmentId.make("reference"),
  settings: {
    ...DEFAULT_SERVER_SETTINGS,
    sidebarAutoSettleAfterDays: 7,
    sidebarAutoSettleOnMerge: true,
    newWorktreesStartFromOrigin: false,
    continueThreadsAfterServerUpdate: false,
  },
};

describe("auto-settle and auto-archive settings sync", () => {
  it("notices differing auto-archive days and applies them when auto-archive is included", () => {
    const target = {
      environmentId: EnvironmentId.make("remote"),
      label: "Remote",
      settings: { ...reference.settings, sidebarAutoArchiveSettledAfterDays: 30 },
    };

    const plan = planAutoSettleAndArchiveSync(reference, [target], { includeAutoArchive: true });

    expect(plan.mismatches).toEqual([target]);
    expect(plan.patch).toEqual({
      sidebarAutoSettleAfterDays: 7,
      sidebarAutoSettleOnMerge: true,
      sidebarAutoArchiveSettledAfterDays: 7,
    });
  });

  it("leaves auto-archive out where it cannot be written", () => {
    const target = {
      environmentId: EnvironmentId.make("remote"),
      label: "Remote",
      settings: { ...reference.settings, sidebarAutoArchiveSettledAfterDays: null },
    };

    const plan = planAutoSettleAndArchiveSync(reference, [target], { includeAutoArchive: false });

    expect(plan.mismatches).toEqual([]);
    expect(plan.patch).not.toHaveProperty("sidebarAutoArchiveSettledAfterDays");
  });
});
