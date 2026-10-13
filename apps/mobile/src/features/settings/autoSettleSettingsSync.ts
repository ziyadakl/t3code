import type { EnvironmentId, ProjectId, ServerSettings } from "@t3tools/contracts";

export type AutoSettleSettings = Pick<
  ServerSettings,
  "sidebarAutoSettleAfterDays" | "sidebarAutoSettleOnMerge" | "sidebarAutoArchiveSettledAfterDays"
>;

interface AutoSettleSyncTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId?: ProjectId | null;
  readonly label: string;
  readonly settings: AutoSettleSettings | null;
}

/**
 * Receives connected, capable targets. Applying these defaults must preserve other settings.
 * Auto-archive joins only when every target supports it and no project is selected, since it
 * is environment-wide and older servers cannot store it.
 */
export function planAutoSettleSettingsSync(
  reference: {
    readonly environmentId: EnvironmentId;
    readonly projectId?: ProjectId | null;
    readonly settings: AutoSettleSettings;
  },
  targets: readonly AutoSettleSyncTarget[],
  options: { readonly includeAutoArchive: boolean } = { includeAutoArchive: false },
) {
  const patch: Partial<AutoSettleSettings> = {
    sidebarAutoSettleAfterDays: reference.settings.sidebarAutoSettleAfterDays,
    sidebarAutoSettleOnMerge: reference.settings.sidebarAutoSettleOnMerge,
    ...(options.includeAutoArchive
      ? {
          sidebarAutoArchiveSettledAfterDays: reference.settings.sidebarAutoArchiveSettledAfterDays,
        }
      : {}),
  };
  const keys = Object.keys(patch) as (keyof AutoSettleSettings)[];
  const mismatches = targets.filter((target) => {
    const settings = target.settings;
    return (
      (target.environmentId !== reference.environmentId ||
        target.projectId !== reference.projectId) &&
      settings !== null &&
      keys.some((key) => settings[key] !== patch[key])
    );
  });
  return { patch, mismatches };
}
