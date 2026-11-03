import { DEFAULT_SERVER_SETTINGS, type ServerSettingsPatch } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { ThreadDaysField } from "./components/ThreadDaysField";

const AUTO_ARCHIVE_DEFAULT_DAYS = DEFAULT_SERVER_SETTINGS.sidebarAutoArchiveSettledAfterDays ?? 7;

/** The Auto-archive section of the Threads page: a switch and a days field. */
export function AutoArchiveSection(props: {
  readonly archiveAfterDays: number | null;
  readonly disabled: boolean;
  readonly write: (patch: ServerSettingsPatch) => void;
}) {
  const { archiveAfterDays, disabled, write } = props;
  return (
    <SettingsSection title="Auto-archive">
      <SettingsSwitchRow
        icon="archivebox"
        label="Auto-archive settled threads"
        value={archiveAfterDays !== null}
        disabled={disabled}
        onValueChange={(value) =>
          write({ sidebarAutoArchiveSettledAfterDays: value ? AUTO_ARCHIVE_DEFAULT_DAYS : null })
        }
      />
      {archiveAfterDays !== null ? (
        <View className="flex-row items-center gap-4 px-4 py-4 android:min-h-14 android:py-3">
          <View className="w-[22px] android:w-6" />
          <Text className="flex-1 text-foreground text-lg android:text-base">Settled days</Text>
          <ThreadDaysField
            value={archiveAfterDays}
            disabled={disabled}
            label="Days settled before auto-archive"
            onValueChange={(value) => write({ sidebarAutoArchiveSettledAfterDays: value })}
          />
        </View>
      ) : null}
    </SettingsSection>
  );
}
