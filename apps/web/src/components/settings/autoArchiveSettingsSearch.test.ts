import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

import {
  filterAvailableSettingsSearchItems,
  getSettingsSearchTargetScope,
  getThreadAutoSettlementSearchAvailability,
  searchSettings,
} from "./settingsSearch";

vi.mock("~/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/env")>()),
  isSecretsFeatureEnabled: false,
}));

describe("auto-archive settings search", () => {
  it("offers auto-archive settings only when a server supports them", () => {
    const itemIds = (hasThreadAutoArchive: boolean) =>
      searchSettings(
        "auto-archive",
        filterAvailableSettingsSearchItems({
          hasCloudPublicConfig: false,
          hasEnvironment: true,
          hasProviderSettingsEnvironment: true,
          canManageLocalBackend: false,
          isWslSettingsRowVisible: false,
          hasThreadAutoSettlement: true,
          hasThreadAutoArchive,
        }),
      ).map((item) => item.id);

    expect(itemIds(false)).toEqual([]);
    expect(itemIds(true)).toEqual(["auto-archive-settled-threads", "days-before-auto-archive"]);
  });

  it.each(["auto-archive-settled-threads", "days-before-auto-archive"])(
    "retains the auto-archive capability requirement for %s",
    (targetId) => {
      expect(getSettingsSearchTargetScope(targetId)).toMatchObject({
        requiresThreadAutoArchive: true,
      });
    },
  );
});

describe("auto-archive search availability", () => {
  function environment(id: string, capabilities: Record<string, boolean>) {
    return {
      environmentId: EnvironmentId.make(id),
      connection: { phase: "connected" as const },
      serverConfig: { environment: { capabilities } },
    };
  }

  it("judges the auto-archive capability, not auto-settlement", () => {
    const settleOnly = environment("settle-only", { threadAutoSettlement: true });
    const archiving = environment("archiving", {
      threadAutoSettlement: true,
      threadAutoArchive: true,
    });

    expect(
      getThreadAutoSettlementSearchAvailability(
        [settleOnly, archiving],
        { kind: "environment", environmentIds: [settleOnly.environmentId] },
        "threadAutoArchive",
      ),
    ).toEqual({ eligibleEnvironmentIds: [archiving.environmentId], isTargetAvailable: false });
  });
});
