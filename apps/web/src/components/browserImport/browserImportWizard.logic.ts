import type {
  BrowserImportFailureReason,
  BrowserImportSite,
  BrowserImportSource,
} from "@t3tools/contracts";

export interface WizardTargetProfile {
  readonly id: string;
  readonly name: string;
}

export type WizardTarget =
  | { readonly kind: "new"; readonly profileId: string }
  | { readonly kind: "existing"; readonly profileId: string; readonly name: string };

export type WizardTargetSelection =
  | { readonly kind: "new" }
  | { readonly kind: "existing"; readonly profileId: string };

/**
 * Where "Into" starts: the requested profile when it is a valid target (the
 * preview tab's own profile), else a new profile, else the first existing one.
 * A locked target always stays on the requested profile, even when it is no
 * longer listed, so the wizard reports it gone instead of importing elsewhere.
 */
export function initialTargetSelection(
  canCreateProfile: boolean,
  targetProfiles: ReadonlyArray<WizardTargetProfile>,
  initialTargetProfileId?: string,
  targetLocked = false,
): WizardTargetSelection {
  if (targetLocked && initialTargetProfileId !== undefined) {
    return { kind: "existing", profileId: initialTargetProfileId };
  }
  const requested = targetProfiles.find((profile) => profile.id === initialTargetProfileId);
  if (requested) return { kind: "existing", profileId: requested.id };
  if (canCreateProfile) return { kind: "new" };
  const first = targetProfiles[0];
  return first ? { kind: "existing", profileId: first.id } : { kind: "new" };
}

export function resolveWizardTarget(
  selection: WizardTargetSelection,
  newProfileId: string,
  targetProfiles: ReadonlyArray<WizardTargetProfile>,
): WizardTarget | undefined {
  if (selection.kind === "new") return { kind: "new", profileId: newProfileId };
  const profile = targetProfiles.find((candidate) => candidate.id === selection.profileId);
  if (profile === undefined) return undefined;
  return {
    kind: "existing",
    profileId: selection.profileId,
    name: profile.name,
  };
}

/**
 * What the import wizard produces once it has actually tried to import. The
 * parent runs the import and classifies the result; the wizard only reacts to
 * it, which keeps the step transitions pure and testable.
 */
export type ImportOutcome =
  | {
      readonly kind: "imported";
      readonly imported: number;
      readonly skipped: number;
      readonly skippedDomains: ReadonlyArray<string>;
      readonly targetName: string;
    }
  | { readonly kind: "blocked"; readonly reason: BrowserImportFailureReason };

/** A run the blocked screen's "Try again" can repeat. */
export type BlockedRetry = "import" | "listSites";

/** What "Try again" does: repeat a run, or start over at configure. */
export type BlockedRetryAction = BlockedRetry | "configure";

/**
 * The wizard's screens. Every one is a place the user can act from — there are
 * no dead ends. `blocked` covers the reasons no local step recovers.
 */
export type WizardStep =
  | { readonly step: "quit" }
  | {
      readonly step: "fullDiskAccess";
      readonly resume: "configure" | "import";
      readonly checked?: boolean;
    }
  | { readonly step: "configure" }
  | { readonly step: "loadingSites" }
  /** Sites are already in `orderSites` order. */
  | { readonly step: "sites"; readonly sites: ReadonlyArray<BrowserImportSite> }
  | { readonly step: "checking"; readonly check: "browser" | "fullDiskAccess" }
  | { readonly step: "importing" }
  | {
      readonly step: "done";
      readonly imported: number;
      readonly skipped: number;
      readonly skippedDomains: ReadonlyArray<string>;
      readonly targetName: string;
    }
  | {
      readonly step: "blocked";
      readonly reason: BrowserImportFailureReason;
      /** What "Try again" re-runs; absent when nothing was attempted yet. */
      readonly retry?: BlockedRetry;
    };

/** The import owns its target partition until the write finishes. */
export function canCloseWizard(step: WizardStep): boolean {
  return step.step !== "importing";
}

/** What listing a source profile's sites produces; the parent reads the store. */
export type SitesOutcome =
  | { readonly kind: "sites"; readonly sites: ReadonlyArray<BrowserImportSite> }
  | { readonly kind: "blocked"; readonly reason: BrowserImportFailureReason };

/**
 * Where the wizard opens for a source. A running browser is the one thing we
 * know up front, from the source listing; everything else is discovered by
 * trying, so the wizard starts by letting the user choose what to import.
 */
export function initialWizardStep(source: BrowserImportSource): WizardStep {
  if (source.unavailable === "browserRunning") return { step: "quit" };
  if (source.unavailable === "needsFullDiskAccess") {
    return { step: "fullDiskAccess", resume: "configure" };
  }
  if (source.unavailable !== undefined) return { step: "blocked", reason: source.unavailable };
  if (source.profiles.length === 0) return { step: "blocked", reason: "unknownSourceProfile" };
  return { step: "configure" };
}

/** Where an attempted import lands the wizard, by how it turned out. */
export function outcomeToStep(outcome: ImportOutcome): WizardStep {
  if (outcome.kind === "imported") {
    return {
      step: "done",
      imported: outcome.imported,
      skipped: outcome.skipped,
      skippedDomains: outcome.skippedDomains,
      targetName: outcome.targetName,
    };
  }
  // A browser that reopened mid-import routes back to the quit screen; every
  // other failure surfaces on the blocked screen, which offers a retry when
  // one could help.
  if (outcome.reason === "browserRunning") return { step: "quit" };
  if (outcome.reason === "needsFullDiskAccess") {
    // The failed import already checked access, so explain that it is still
    // denied instead of returning to an indistinguishable permission screen.
    return { step: "fullDiskAccess", resume: "import", checked: true };
  }
  return { step: "blocked", reason: outcome.reason, retry: "import" };
}

/** Where a fresh availability check lands the wizard after the user quits. */
export function refreshedSourceStep(source: BrowserImportSource | undefined): WizardStep {
  if (source === undefined) return { step: "blocked", reason: "unknownSource" };
  return initialWizardStep(source);
}

/** A denied FDA recheck returns to the permission step with visible feedback. */
export function fullDiskAccessRecheckStep(source: BrowserImportSource | undefined): WizardStep {
  const next = refreshedSourceStep(source);
  return next.step === "fullDiskAccess" ? { ...next, checked: true } : next;
}

/** Preserve the chosen source profile when a post-quit refresh still lists it. */
export function refreshedSourceProfileDirectory(
  currentDirectory: string,
  source: BrowserImportSource,
): string {
  if (source.profiles.some((profile) => profile.directory === currentDirectory)) {
    return currentDirectory;
  }
  return source.profiles[0]?.directory ?? "";
}

/**
 * Whether retrying could clear a failure: the keychain prompt can be approved on a second
 * try, a missing key appears once the user signs in, and a read or session error may be
 * transient; an unsupported browser will not change, so it gets no retry button.
 */
export function isRetryableReason(reason: BrowserImportFailureReason): boolean {
  switch (reason) {
    case "needsKeychainApproval":
    case "keychainItemMissing":
    case "keychainUnavailable":
    case "readFailed":
    case "sessionUnavailable":
    case "profileNotSaved":
      return true;
    default:
      return false;
  }
}

/**
 * Names the sites whose cookies were skipped: "example.com and google.com",
 * or "a, b, c and 4 more" past a few, so the line stays short.
 */
export function formatSkippedDomains(domains: ReadonlyArray<string>): string {
  if (domains.length === 0) return "";
  if (domains.length === 1) return domains[0]!;
  if (domains.length <= 3) return `${domains.slice(0, -1).join(", ")} and ${domains.at(-1)}`;
  return `${domains.slice(0, 3).join(", ")} and ${domains.length - 3} more`;
}

/**
 * The order the sites step lists them in: the site the preview tab is showing,
 * then the most recently used, then alphabetically.
 */
export function orderSites(sites: ReadonlyArray<BrowserImportSite>): BrowserImportSite[] {
  return sites.toSorted((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    const aTime = a.lastAccessedAt ?? Number.NEGATIVE_INFINITY;
    const bTime = b.lastAccessedAt ?? Number.NEGATIVE_INFINITY;
    if (aTime !== bTime) return bTime - aTime;
    return a.domain.localeCompare(b.domain);
  });
}

const PRESELECTED_SITE_LIMIT = 5;

/**
 * The domains ticked when the sites step first opens: the first few signed-in
 * sites, never a banking, email or sign-in one. Pass sites already ordered.
 */
export function initialSiteSelection(orderedSites: ReadonlyArray<BrowserImportSite>): string[] {
  return orderedSites
    .filter((entry) => entry.signedIn && entry.sensitive === undefined)
    .slice(0, PRESELECTED_SITE_LIMIT)
    .map((entry) => entry.domain);
}

/** Sites whose domain contains the query, ignoring case; all of them for an empty query. */
export function filterSites(
  sites: ReadonlyArray<BrowserImportSite>,
  query: string,
): ReadonlyArray<BrowserImportSite> {
  const needle = query.trim().toLowerCase();
  if (needle === "") return sites;
  return sites.filter((entry) => entry.domain.toLowerCase().includes(needle));
}

const SITE_ROW_LIMIT = 200;

/**
 * The rows the sites list renders. A browser profile can hold thousands of
 * sites, so past the limit only the first rows render and the rest are
 * counted; filtering narrows them. Selection still applies to every site.
 */
export function capSiteRows(sites: ReadonlyArray<BrowserImportSite>): {
  readonly rows: ReadonlyArray<BrowserImportSite>;
  readonly hidden: number;
} {
  if (sites.length <= SITE_ROW_LIMIT) return { rows: sites, hidden: 0 };
  return { rows: sites.slice(0, SITE_ROW_LIMIT), hidden: sites.length - SITE_ROW_LIMIT };
}

/**
 * The sites step's bulk buttons. Selecting ticks every site the filter
 * matches, including matches past the row cap that are not rendered, so it
 * says "matches" while a filter is typed; clearing always empties the whole
 * selection, so it always says "all".
 */
export function siteBulkActionLabels(query: string): {
  readonly select: string;
  readonly clear: string;
} {
  return {
    select: query.trim() === "" ? "Select all" : "Select all matches",
    clear: "Clear all",
  };
}

/**
 * The selection after the bulk select: every site matching the query is added,
 * rendered or not, after the domains already selected.
 */
export function selectMatchingSites(
  selected: ReadonlyArray<string>,
  sites: ReadonlyArray<BrowserImportSite>,
  query: string,
): string[] {
  const selectedSet = new Set(selected);
  return [
    ...selected,
    ...filterSites(sites, query)
      .map((entry) => entry.domain)
      .filter((domain) => !selectedSet.has(domain)),
  ];
}

/** Where listing a profile's sites lands the wizard. */
export function sitesOutcomeToStep(outcome: SitesOutcome): WizardStep {
  if (outcome.kind === "sites") return { step: "sites", sites: orderSites(outcome.sites) };
  if (outcome.reason === "browserRunning") return { step: "quit" };
  if (outcome.reason === "needsFullDiskAccess") {
    return { step: "fullDiskAccess", resume: "configure", checked: true };
  }
  return { step: "blocked", reason: outcome.reason, retry: "listSites" };
}

/**
 * What the blocked screen's "Try again" does: re-run the import or listing
 * that failed, with the same choices, or start over at configure when the
 * source was blocked before anything ran. Undefined hides the button.
 */
export function blockedRetryAction(
  step: Extract<WizardStep, { step: "blocked" }>,
): BlockedRetryAction | undefined {
  if (!isRetryableReason(step.reason)) return undefined;
  return step.retry ?? "configure";
}

/** The ticked domains, remembered for the source profile they were ticked in. */
export interface SiteSelection {
  readonly sourceProfileDirectory: string;
  readonly domains: ReadonlyArray<string>;
}

/**
 * The selection to show once a profile's sites are listed. Going Back and
 * Continuing on the same profile keeps the user's ticks (minus any site that
 * has since gone); another profile starts from the default ticks.
 */
export function siteSelectionFor(
  previous: SiteSelection | undefined,
  sourceProfileDirectory: string,
  orderedSites: ReadonlyArray<BrowserImportSite>,
): SiteSelection {
  if (previous?.sourceProfileDirectory !== sourceProfileDirectory) {
    return { sourceProfileDirectory, domains: initialSiteSelection(orderedSites) };
  }
  const listed = new Set(orderedSites.map((entry) => entry.domain));
  return {
    sourceProfileDirectory,
    domains: previous.domains.filter((domain) => listed.has(domain)),
  };
}

/** At least one registrable domain: an import always names the sites it brings over. */
export type ImportDomains = readonly [string, ...string[]];

/**
 * The domains an import may run with: the ticks made for the source profile
 * being imported. Undefined when nothing was chosen for it yet, so the wizard
 * sends the user back to pick sites instead of importing nothing.
 */
export function selectedImportDomains(
  selection: SiteSelection | undefined,
  sourceProfileDirectory: string,
): ImportDomains | undefined {
  if (selection?.sourceProfileDirectory !== sourceProfileDirectory) return undefined;
  const [first, ...rest] = selection.domains;
  return first === undefined ? undefined : [first, ...rest];
}
