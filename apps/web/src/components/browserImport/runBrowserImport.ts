import {
  BROWSER_PROFILE_MAX_COUNT,
  resolveBrowserProfiles,
  type BrowserImportFailureReason,
  type BrowserImportSource,
  type BrowserProfile,
  type EnvironmentId,
} from "@t3tools/contracts";

import { clearBrowserProfileData } from "~/browser/browserProfileData";
import type { previewBridge } from "~/components/preview/previewBridge";

import { importFailureReason } from "./browserImportLauncher.logic";
import type { ImportOutcome, WizardTarget } from "./browserImportWizard.logic";

export type BrowserImportBridge = Pick<
  NonNullable<typeof previewBridge>,
  "importBrowserCookies" | "clearCookies" | "clearCache"
>;

/** The saved browser profiles, read now or updated against the newest copy. */
export interface BrowserProfileStore {
  readonly current: () => ReadonlyArray<BrowserProfile>;
  /** Saves what `update` returns; rejects, saving nothing, when `update` throws or the write fails. */
  readonly update: (
    update: (profiles: ReadonlyArray<BrowserProfile>) => ReadonlyArray<BrowserProfile>,
  ) => Promise<ReadonlyArray<BrowserProfile>>;
}

export interface BrowserImportRun {
  readonly source: BrowserImportSource;
  readonly destination: { readonly environmentId: EnvironmentId };
  /** Runs once cookies have landed in `targetProfileId`. */
  readonly onImported?: ((targetProfileId: string) => void) | undefined;
}

export interface BrowserImportChoice {
  readonly sourceProfileDirectory: string;
  readonly target: WizardTarget;
  readonly domains: ReadonlyArray<string>;
}

/** The cap was reached while the import ran; thrown from inside the settings updater. */
class ProfileLimitReachedError extends Error {}

/**
 * Copies the chosen sites' cookies into the target profile and settles what the wizard shows.
 * A new profile is registered only once something came over; if it cannot then be saved, its
 * partition is cleared so no cookies sit behind a profile lost on restart. Never rejects.
 */
export async function runBrowserImport(
  bridge: BrowserImportBridge,
  profiles: BrowserProfileStore,
  run: BrowserImportRun,
  choice: BrowserImportChoice,
): Promise<ImportOutcome> {
  const { source, destination } = run;
  const { target } = choice;
  const targetStillExists = () =>
    resolveBrowserProfiles(profiles.current()).some((profile) => profile.id === target.profileId);
  if (target.kind === "existing" && !targetStillExists()) {
    return { kind: "blocked", reason: "readFailed" };
  }

  let result;
  try {
    result = await bridge.importBrowserCookies({
      environmentId: destination.environmentId,
      sourceId: source.id,
      sourceProfileDirectory: choice.sourceProfileDirectory,
      targetProfileId: target.profileId,
      domains: choice.domains,
    });
  } catch (cause) {
    return { kind: "blocked", reason: importFailureReason(cause) };
  }

  let targetName = target.kind === "existing" ? target.name : source.name;
  if (target.kind === "existing" && !targetStillExists()) {
    return { kind: "blocked", reason: "readFailed" };
  }
  if (target.kind === "new" && result.imported > 0) {
    const registered = await registerNewProfile(profiles, source.name, target.profileId);
    if (registered.kind === "failed") {
      await clearBrowserProfileData(bridge, [destination.environmentId], target.profileId).catch(
        () => undefined,
      );
      return { kind: "blocked", reason: registered.reason };
    }
    targetName = registered.name;
  }

  if (result.imported > 0) run.onImported?.(target.profileId);
  return {
    kind: "imported",
    imported: result.imported,
    skipped: result.skipped,
    skippedDomains: result.skippedDomains,
    targetName,
  };
}

async function registerNewProfile(
  profiles: BrowserProfileStore,
  baseName: string,
  profileId: string,
): Promise<
  | { readonly kind: "saved"; readonly name: string }
  | { readonly kind: "failed"; readonly reason: BrowserImportFailureReason }
> {
  try {
    const saved = await profiles.update((current) => {
      if (current.some((profile) => profile.id === profileId)) return current;
      // The wizard refuses a new target at the cap, but the cap can be reached
      // while the import runs; the updater sees the newest settings, so this is
      // the check that holds.
      if (current.length >= BROWSER_PROFILE_MAX_COUNT) throw new ProfileLimitReachedError();
      const taken = new Set(resolveBrowserProfiles(current).map((profile) => profile.name));
      let name = baseName;
      for (let index = 2; taken.has(name); index += 1) name = `${baseName} ${index}`;
      return [...current, { id: profileId, name, kind: "persistent" }];
    });
    return {
      kind: "saved",
      name: saved.find((profile) => profile.id === profileId)?.name ?? baseName,
    };
  } catch (cause) {
    // Not a read failure: the cookies came over and could not be kept.
    return {
      kind: "failed",
      reason: cause instanceof ProfileLimitReachedError ? "profileLimitReached" : "profileNotSaved",
    };
  }
}
