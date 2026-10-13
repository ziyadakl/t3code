import {
  BrowserImportFailureReason,
  type BrowserImportSite,
  type BrowserImportSource,
} from "@t3tools/contracts";

import type { SitesOutcome } from "./browserImportWizard.logic";

/**
 * IPC flattens the failure to its message, so the reason token travels inside
 * it. Anything unrecognised reads as a plain read failure rather than leaking
 * the raw message into the wizard.
 */
export const importFailureReason = (cause: unknown): BrowserImportFailureReason => {
  const message = String((cause as { message?: unknown } | undefined)?.message ?? "");
  return (
    BrowserImportFailureReason.literals.find((reason) => message.includes(`failed: ${reason}.`)) ??
    "readFailed"
  );
};

/** A site listing for the wizard, failing the same way an import does. */
export const listSitesOutcome = (
  listing: Promise<ReadonlyArray<BrowserImportSite>>,
): Promise<SitesOutcome> =>
  listing.then(
    (sites): SitesOutcome => ({ kind: "sites", sites }),
    (cause): SitesOutcome => ({ kind: "blocked", reason: importFailureReason(cause) }),
  );

/**
 * Browsers worth offering. One that is not on this machine is left out rather
 * than listed as a dead row, and so is an unsupported one, since the blocked
 * wizard step can't be fixed from anywhere. Every other unavailable reason
 * stays, because each names a step the user can take.
 */
export function importableBrowserSources(
  sources: ReadonlyArray<BrowserImportSource>,
): ReadonlyArray<BrowserImportSource> {
  return sources.filter(
    (source) =>
      source.unavailable !== "notInstalled" && source.unavailable !== "unsupportedPlatform",
  );
}

/**
 * The preview pane's one-time import prompt. `sources` is null until the one
 * lazy listing returns, which keeps the banner from appearing and then
 * vanishing on a machine with no importable browser.
 */
export function shouldShowCookieImportBanner(input: {
  readonly importSupported: boolean;
  readonly profilePersistent: boolean;
  readonly dismissed: boolean;
  readonly sources: ReadonlyArray<BrowserImportSource> | null;
}): boolean {
  if (!input.importSupported || !input.profilePersistent || input.dismissed) return false;
  return input.sources !== null && importableBrowserSources(input.sources).length > 0;
}

/** The only browser worth offering, when there is no choice to show. */
export function singleImportableSource(
  sources: ReadonlyArray<BrowserImportSource>,
): BrowserImportSource | undefined {
  const importable = importableBrowserSources(sources);
  return importable.length === 1 ? importable[0] : undefined;
}
