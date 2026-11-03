import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { describe, expect, it } from "vite-plus/test";

import { settingInheritanceLayers } from "./SettingInheritance";

const environmentId = EnvironmentId.make("laptop");

describe("settingInheritanceLayers", () => {
  it.each(["sidebarAutoSettleAfterDays", "sidebarAutoArchiveSettledAfterDays"] as const)(
    "shows %s as days, and off as Never",
    (key) => {
      const settings = { ...DEFAULT_SERVER_SETTINGS, [key]: null };
      const layers = settingInheritanceLayers(
        {
          environmentId,
          label: "Laptop",
          projectId: null,
          ...resolveProjectSettings(settings, null),
        },
        settings,
        key,
      );
      expect(layers.map((layer) => layer.value)).toEqual([
        "Never",
        `${DEFAULT_SERVER_SETTINGS[key]} days`,
      ]);
    },
  );
});
