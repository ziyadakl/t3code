/**
 * Fork (grouped layout): the "Group threads by project" and "Float to the top"
 * rows of Settings → General, with their "Restore defaults" pieces.
 */
import {
  DEFAULT_UNIFIED_SETTINGS,
  type SidebarFloatToTopStatus,
} from "@t3tools/contracts/settings";
import * as Equal from "effect/Equal";

import { Switch } from "../../ui/switch";
import { SettingResetButton, SettingsRow } from "../../settings/settingsLayout";
import { searchableSetting } from "../../settings/settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "../../settings/useScopedSettings";

const SIDEBAR_FLOAT_TO_TOP_STATUS_OPTIONS: ReadonlyArray<{
  readonly status: SidebarFloatToTopStatus;
  readonly label: string;
}> = [
  { status: "done", label: "Done" },
  { status: "input", label: "Needs input" },
  { status: "approval", label: "Needs approval" },
  { status: "failed", label: "Failed" },
  { status: "woke", label: "Woke" },
  { status: "limited", label: "Limited" },
  { status: "waiting", label: "Waiting" },
];

/** The "Restore defaults" labels for the project-group settings that differ from their defaults. */
export function projectGroupsChangedLabels(settings: {
  readonly sidebarProjectGroupsEnabled: boolean;
  readonly sidebarFloatToTopStatuses: unknown;
}): string[] {
  return [
    ...(settings.sidebarProjectGroupsEnabled !==
    DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupsEnabled
      ? ["Group threads by project"]
      : []),
    ...(!Equal.equals(
      settings.sidebarFloatToTopStatuses,
      DEFAULT_UNIFIED_SETTINGS.sidebarFloatToTopStatuses,
    )
      ? ["Float to the top"]
      : []),
  ];
}

/** What "Restore defaults" writes for the project-group settings. */
export const PROJECT_GROUPS_RESTORE_DEFAULTS = {
  sidebarProjectGroupsEnabled: DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupsEnabled,
  sidebarFloatToTopStatuses: DEFAULT_UNIFIED_SETTINGS.sidebarFloatToTopStatuses,
};

export function ProjectGroupsSettingsRows() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <>
      <SettingsRow
        {...searchableSetting("sidebar-project-groups")}
        description="Fold active threads under one header per project. Turn off for a flat list."
        resetAction={
          settings.sidebarProjectGroupsEnabled !==
          DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupsEnabled ? (
            <SettingResetButton
              label="project groups"
              onClick={() =>
                updateSettings({
                  sidebarProjectGroupsEnabled: DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupsEnabled,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.sidebarProjectGroupsEnabled}
            onCheckedChange={(checked) =>
              updateSettings({ sidebarProjectGroupsEnabled: Boolean(checked) })
            }
            aria-label="Group threads by project"
          />
        }
      />

      {settings.sidebarProjectGroupsEnabled ? (
        <SettingsRow
          {...searchableSetting("sidebar-float-to-top")}
          description="Threads with these statuses sit above the project groups until the status clears."
          resetAction={
            !Equal.equals(
              settings.sidebarFloatToTopStatuses,
              DEFAULT_UNIFIED_SETTINGS.sidebarFloatToTopStatuses,
            ) ? (
              <SettingResetButton
                label="float to the top"
                onClick={() =>
                  updateSettings({
                    sidebarFloatToTopStatuses: DEFAULT_UNIFIED_SETTINGS.sidebarFloatToTopStatuses,
                  })
                }
              />
            ) : null
          }
        >
          <div className="mt-3 grid max-w-2xl gap-x-6 gap-y-2 pb-3.5 sm:grid-cols-2">
            {SIDEBAR_FLOAT_TO_TOP_STATUS_OPTIONS.map(({ status, label }) => (
              <label key={status} className="flex items-center justify-between gap-3">
                <span className="text-sm">{label}</span>
                <Switch
                  checked={settings.sidebarFloatToTopStatuses[status]}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      sidebarFloatToTopStatuses: {
                        ...settings.sidebarFloatToTopStatuses,
                        [status]: Boolean(checked),
                      },
                    })
                  }
                  aria-label={`Float ${label} threads to the top`}
                />
              </label>
            ))}
          </div>
        </SettingsRow>
      ) : null}
    </>
  );
}
