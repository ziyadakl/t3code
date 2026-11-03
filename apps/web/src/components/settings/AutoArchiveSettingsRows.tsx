import { useState } from "react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
} from "@t3tools/contracts/settings";

import { Input } from "../ui/input";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const AUTO_ARCHIVE_DEFAULT_DAYS = DEFAULT_UNIFIED_SETTINGS.sidebarAutoArchiveSettledAfterDays ?? 7;

/** The "Restore defaults" label for the auto-archive setting, when it differs from its default. */
export function autoArchiveChangedLabels(settings: {
  readonly sidebarAutoArchiveSettledAfterDays: number | null;
}): string[] {
  return settings.sidebarAutoArchiveSettledAfterDays !==
    DEFAULT_UNIFIED_SETTINGS.sidebarAutoArchiveSettledAfterDays
    ? ["Auto-archive settled threads"]
    : [];
}

/** What "Restore defaults" writes for the auto-archive setting. */
export const AUTO_ARCHIVE_RESTORE_DEFAULTS = {
  sidebarAutoArchiveSettledAfterDays: DEFAULT_UNIFIED_SETTINGS.sidebarAutoArchiveSettledAfterDays,
};

function ArchiveDaysInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (days: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [draftSource, setDraftSource] = useState(value);
  if (draftSource !== value) {
    setDraftSource(value);
    setDraft(String(value));
  }

  return (
    <Input
      size="sm"
      type="number"
      min={MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      max={MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      className="w-full sm:w-24"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        const parsed = Number(event.target.value);
        if (
          Number.isInteger(parsed) &&
          parsed >= MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS &&
          parsed <= MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS
        ) {
          onCommit(parsed);
        }
      }}
      onBlur={() => setDraft(String(value))}
      aria-label="Days settled before auto-archive"
    />
  );
}

/** The auto-archive switch and its days field, shown only when every connected server supports it. */
export function AutoArchiveSettingsRows() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { connectedEnvironments } = useSettingsScope();
  const supportsAutoArchive =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (target) => target.serverConfig?.environment.capabilities.threadAutoArchive === true,
    );
  if (!supportsAutoArchive) return null;

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["sidebarAutoArchiveSettledAfterDays"]}
        {...searchableSetting("auto-archive-settled-threads")}
        description="Archive threads that stay settled this long. Helper threads are archived with their parent either way."
        resetAction={
          settings.sidebarAutoArchiveSettledAfterDays !==
          DEFAULT_UNIFIED_SETTINGS.sidebarAutoArchiveSettledAfterDays ? (
            <SettingResetButton
              label="auto-archive"
              onClick={() =>
                updateSettings({
                  sidebarAutoArchiveSettledAfterDays:
                    DEFAULT_UNIFIED_SETTINGS.sidebarAutoArchiveSettledAfterDays,
                })
              }
            />
          ) : null
        }
        control={
          <ScopedSwitch
            settingKeys={["sidebarAutoArchiveSettledAfterDays"]}
            checked={settings.sidebarAutoArchiveSettledAfterDays !== null}
            onCheckedChange={(checked) =>
              updateSettings({
                sidebarAutoArchiveSettledAfterDays: checked ? AUTO_ARCHIVE_DEFAULT_DAYS : null,
              })
            }
            aria-label="Auto-archive settled threads"
          />
        }
      />
      {settings.sidebarAutoArchiveSettledAfterDays !== null ? (
        <SettingsRow
          serverScoped
          settingKeys={["sidebarAutoArchiveSettledAfterDays"]}
          title={searchableSetting("days-before-auto-archive").title}
          description="Pinned and snoozed threads are never archived automatically."
          control={
            <ArchiveDaysInput
              value={settings.sidebarAutoArchiveSettledAfterDays}
              onCommit={(days) => updateSettings({ sidebarAutoArchiveSettledAfterDays: days })}
            />
          }
        />
      ) : null}
    </>
  );
}
