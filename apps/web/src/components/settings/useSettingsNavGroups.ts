import { useEnvironments } from "~/state/environments";
import { SETTINGS_NAV_GROUPS } from "./settingsSearch";

/** The nav groups, without Storage when no connected machine can report disk use. */
export function useSettingsNavGroups() {
  const { environments } = useEnvironments();
  const storageSupported = environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.storageOverview === true,
  );
  return storageSupported
    ? SETTINGS_NAV_GROUPS
    : SETTINGS_NAV_GROUPS.map((group) => ({
        ...group,
        paths: group.paths.filter((path) => path !== "/settings/disk"),
      }));
}
