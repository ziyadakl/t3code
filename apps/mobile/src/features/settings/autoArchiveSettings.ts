import type { ServerSettings } from "@t3tools/contracts";

import { planAutoSettleSettingsSync, type AutoSettleSettings } from "./autoSettleSettingsSync";
import type { ScopedMobileSettingsTarget } from "./settings-scoped-server";

type AutoSettleAndArchiveSettings = AutoSettleSettings &
  Pick<ServerSettings, "sidebarAutoArchiveSettledAfterDays">;

/**
 * Auto-archive is environment-wide, so it is hidden while a project is selected, and it needs
 * every selected server to support it, since older servers cannot store it.
 */
export function supportsAutoArchive(
  displayTargets: readonly ScopedMobileSettingsTarget[],
  projectSelected: boolean,
): boolean {
  return (
    !projectSelected &&
    displayTargets.every(
      (target) =>
        target.environment.serverConfig.environment.capabilities.threadAutoArchive === true,
    )
  );
}

/**
 * Upstream's auto-settle plan, plus the auto-archive days when `includeAutoArchive` is set, so
 * one "defaults differ" banner covers both.
 */
export function planAutoSettleAndArchiveSync(
  reference: Parameters<typeof planAutoSettleSettingsSync>[0] & {
    readonly settings: AutoSettleAndArchiveSettings;
  },
  targets: readonly (Parameters<typeof planAutoSettleSettingsSync>[1][number] & {
    readonly settings: AutoSettleAndArchiveSettings | null;
  })[],
  options: { readonly includeAutoArchive: boolean },
) {
  const plan = planAutoSettleSettingsSync(reference, targets);
  if (!options.includeAutoArchive) return plan;
  const archiveDays = reference.settings.sidebarAutoArchiveSettledAfterDays;
  return {
    patch: { ...plan.patch, sidebarAutoArchiveSettledAfterDays: archiveDays },
    mismatches: targets.filter(
      (target) =>
        plan.mismatches.includes(target) ||
        ((target.environmentId !== reference.environmentId ||
          target.projectId !== reference.projectId) &&
          target.settings !== null &&
          target.settings.sidebarAutoArchiveSettledAfterDays !== archiveDays),
    ),
  };
}

/** The "defaults differ" banner text: it names auto-archive only where that is synced too. */
export function autoSettleBannerText(includesAutoArchive: boolean) {
  return {
    title: includesAutoArchive
      ? "Auto-settle and auto-archive defaults differ"
      : "Auto-settle defaults differ",
    applyLabel: includesAutoArchive ? "Apply these defaults" : "Apply auto-settle defaults",
  };
}
