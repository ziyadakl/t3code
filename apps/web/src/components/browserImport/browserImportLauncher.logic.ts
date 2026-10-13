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
 * The preview pane's one-time import prompt, asked only where an import into
 * the tab's profile is possible. `sources` is null until the one lazy listing
 * returns, which keeps the banner from appearing and then vanishing on a
 * machine with no importable browser.
 */
export function shouldShowCookieImportBanner(input: {
  readonly dismissed: boolean;
  readonly sources: ReadonlyArray<BrowserImportSource> | null;
}): boolean {
  if (input.dismissed || input.sources === null) return false;
  return importableBrowserSources(input.sources).length > 0;
}

/**
 * What the preview does once an import it opened lands cookies. The prompt has
 * done its job either way; the tab reloads only if it still shows the profile
 * the cookies went into, since it can switch profile while the import runs.
 */
export function previewImportLanded(
  importedProfileId: string,
  tabProfileId: string,
): { readonly reloadTab: boolean; readonly dismissBanner: boolean } {
  return { reloadTab: importedProfileId === tabProfileId, dismissBanner: true };
}

/** The only browser worth offering, when there is no choice to show. */
export function singleImportableSource(
  sources: ReadonlyArray<BrowserImportSource>,
): BrowserImportSource | undefined {
  const importable = importableBrowserSources(sources);
  return importable.length === 1 ? importable[0] : undefined;
}

/**
 * The banner's one-click button opens the wizard from a fresh listing, never
 * the one the banner was built from: a browser quit or a profile added since
 * then must show as it is now. A browser no longer worth offering doesn't
 * open at all; the banner takes the fresh listing instead.
 */
export function freshBannerChoice(
  fresh: ReadonlyArray<BrowserImportSource>,
  sourceId: BrowserImportSource["id"],
):
  | { readonly kind: "open"; readonly source: BrowserImportSource }
  | { readonly kind: "refresh"; readonly sources: ReadonlyArray<BrowserImportSource> } {
  const source = importableBrowserSources(fresh).find((candidate) => candidate.id === sourceId);
  return source ? { kind: "open", source } : { kind: "refresh", sources: fresh };
}

/**
 * Runs `load` until it gives an answer worth keeping (any answer, by default),
 * then shares that answer for the rest of the app session, including with
 * callers that arrive while it is still running. A failure, or an answer
 * `keep` rejects, is not kept, so the next caller tries again.
 */
export function oncePerSession<T>(
  load: () => Promise<T>,
  keep: (value: T) => boolean = () => true,
): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (pending) return pending;
    const attempt = load().then(
      (value) => {
        if (!keep(value) && pending === attempt) pending = null;
        return value;
      },
      (cause: unknown) => {
        if (pending === attempt) pending = null;
        throw cause;
      },
    );
    pending = attempt;
    return attempt;
  };
}
