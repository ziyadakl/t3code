import { describe, expect, it, vi } from "vite-plus/test";

import { filterAvailableSettingsSearchItems, searchSettings } from "../../settings/settingsSearch";

vi.mock("~/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/env")>()),
  isSecretsFeatureEnabled: false,
}));

describe("project groups settings search", () => {
  it("finds the sidebar project group settings", () => {
    expect(searchSettings("fold threads by project")[0]?.id).toBe("sidebar-project-groups");
    expect(searchSettings("float to the top")[0]?.id).toBe("sidebar-float-to-top");
    expect(searchSettings("needs you")[0]?.id).toBe("sidebar-float-to-top");
  });

  it("offers Float to the top only while project groups are on", () => {
    const itemIds = (sidebarProjectGroupsEnabled: boolean) =>
      searchSettings(
        "float to the top",
        filterAvailableSettingsSearchItems({
          hasCloudPublicConfig: false,
          hasEnvironment: false,
          hasProviderSettingsEnvironment: false,
          canManageLocalBackend: false,
          isWslSettingsRowVisible: false,
          hasThreadAutoSettlement: false,
          hasThreadAutoArchive: false,
          sidebarProjectGroupsEnabled,
        }),
      ).map((item) => item.id);

    expect(itemIds(false)).not.toContain("sidebar-float-to-top");
    expect(itemIds(true)).toContain("sidebar-float-to-top");
  });
});
