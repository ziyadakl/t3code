import { PermissionChecklist, PermissionContinueButton } from "../permissions/PermissionChecklist";
import { usePermissionStatus } from "../permissions/usePermissionStatus";
import type { BrowserImportSite, BrowserImportSource } from "@t3tools/contracts";
import { BROWSER_IMPORT_FAILURE_COPY } from "@t3tools/contracts";
import { ArrowDownIcon, ArrowRightIcon, CheckIcon, HardDriveIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { cn, randomUUID } from "~/lib/utils";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import {
  blockedRetryAction,
  initialWizardStep,
  initialTargetSelection,
  canCloseWizard,
  capSiteRows,
  filterSites,
  formatSkippedDomains,
  siteBulkActionLabels,
  selectMatchingSites,
  fullDiskAccessRecheckStep,
  outcomeToStep,
  refreshedSourceProfileDirectory,
  refreshedSourceStep,
  resolveWizardTarget,
  selectedImportDomains,
  siteSelectionFor,
  sitesOutcomeToStep,
  type BlockedRetryAction,
  type ImportDomains,
  type ImportOutcome,
  type SiteSelection,
  type SitesOutcome,
  type WizardTarget,
  type WizardTargetProfile,
  type WizardTargetSelection,
  type WizardStep,
} from "./browserImportWizard.logic";

export type { WizardTarget } from "./browserImportWizard.logic";

interface BrowserImportWizardProps {
  readonly source: BrowserImportSource;
  readonly destinationEnvironmentName: string;
  readonly targetProfiles: ReadonlyArray<WizardTargetProfile>;
  readonly canCreateProfile: boolean;
  /**
   * Starts "Into" on this existing profile when it is one of `targetProfiles`,
   * so opening from a preview tab imports into the profile being viewed.
   */
  readonly initialTargetProfileId?: string | undefined;
  /**
   * Fixes the target to `initialTargetProfileId` and hides the "Into" picker,
   * so an import started from a preview tab lands in that tab's own session.
   */
  readonly targetLocked?: boolean | undefined;
  /** Lists the sites a source profile holds cookies for, without decrypting. */
  readonly onListSites: (sourceProfileDirectory: string) => Promise<SitesOutcome>;
  /**
   * Runs the import and returns how it went. For a new target the caller only
   * registers the profile once the import succeeds, so a blocked attempt never
   * leaves an empty profile behind.
   */
  readonly onImport: (input: {
    readonly sourceProfileDirectory: string;
    readonly target: WizardTarget;
    /** Registrable domains the user ticked; only their cookies are imported. */
    readonly domains: ImportDomains;
  }) => Promise<ImportOutcome>;
  readonly onRefreshSource: () => Promise<BrowserImportSource | undefined>;
  readonly onOpenFullDiskAccessSettings: () => void | Promise<void>;
  readonly onCheckFullDiskAccess?: (() => Promise<boolean>) | undefined;
  readonly onClose: () => void;
}

export function BrowserImportWizard({
  source: initialSource,
  destinationEnvironmentName,
  targetProfiles,
  canCreateProfile,
  initialTargetProfileId,
  targetLocked,
  onListSites,
  onImport,
  onRefreshSource,
  onOpenFullDiskAccessSettings,
  onCheckFullDiskAccess,
  onClose,
}: BrowserImportWizardProps) {
  const [source, setSource] = useState(initialSource);
  const [step, setStep] = useState<WizardStep>(() => initialWizardStep(initialSource));
  const [sourceProfileDirectory, setSourceProfileDirectory] = useState(
    () => initialSource.profiles[0]?.directory ?? "",
  );
  const locked = targetLocked === true && initialTargetProfileId !== undefined;
  const [target, setTarget] = useState<WizardTargetSelection>(() =>
    initialTargetSelection(canCreateProfile, targetProfiles, initialTargetProfileId, locked),
  );
  // Survives Back and Continue on the same source profile; a listing for
  // another profile replaces it with that profile's default ticks.
  const [siteSelection, setSiteSelection] = useState<SiteSelection>();
  const [targetError, setTargetError] = useState<string>();
  const newProfileId = useRef(`profile-${randomUUID()}`);
  // A second Import click before React has left the configure screen would
  // start a second run; the parent refuses it, and applying that refusal here
  // would drop the wizard out of the importing step while the first write is
  // still going. The ref settles synchronously where state does not.
  const importInFlight = useRef(false);

  const runImport = () => {
    if (importInFlight.current) return;
    const domains = selectedImportDomains(siteSelection, sourceProfileDirectory);
    if (domains === undefined) {
      // Nothing chosen for this source profile; Continue lists its sites.
      setStep({ step: "configure" });
      return;
    }
    const chosen = resolveWizardTarget(target, newProfileId.current, targetProfiles);
    if (chosen === undefined) {
      setTargetError(targetMissingCopy(locked));
      setStep({ step: "configure" });
      return;
    }
    setTargetError(undefined);
    importInFlight.current = true;
    setStep({ step: "importing" });
    void onImport({
      sourceProfileDirectory,
      target: chosen,
      domains,
    })
      .then((outcome) => setStep(outcomeToStep(outcome)))
      .catch(() => setStep({ step: "blocked", reason: "readFailed" }))
      .finally(() => {
        importInFlight.current = false;
      });
  };

  const listSites = () => {
    const directory = sourceProfileDirectory;
    setStep({ step: "loadingSites" });
    void onListSites(directory)
      .then((outcome) => {
        const next = sitesOutcomeToStep(outcome);
        if (next.step === "sites") {
          setSiteSelection((previous) => siteSelectionFor(previous, directory, next.sites));
        }
        setStep(next);
      })
      .catch(() => setStep({ step: "blocked", reason: "readFailed", retry: "listSites" }));
  };

  const retryAction = step.step === "blocked" ? blockedRetryAction(step) : undefined;
  const retryBlocked = (action: BlockedRetryAction) => {
    if (action === "import") runImport();
    else if (action === "listSites") listSites();
    else setStep({ step: "configure" });
  };

  // Re-lists the source after the user did something outside the app (quit the
  // browser, granted access) and routes to wherever the refreshed source says.
  const recheckSource = (
    check: "browser" | "fullDiskAccess",
    nextStep: (refreshed: BrowserImportSource | undefined) => WizardStep,
  ) => {
    setStep({ step: "checking", check });
    void onRefreshSource()
      .then((refreshed) => {
        if (refreshed) {
          setSource(refreshed);
          setSourceProfileDirectory((current) =>
            refreshedSourceProfileDirectory(current, refreshed),
          );
        }
        setStep(nextStep(refreshed));
      })
      .catch(() => setStep({ step: "blocked", reason: "readFailed" }));
  };
  const recheckAfterQuit = () => recheckSource("browser", refreshedSourceStep);
  const recheckFullDiskAccess = () => recheckSource("fullDiskAccess", fullDiskAccessRecheckStep);

  return (
    <Dialog open onOpenChange={(open) => (open || !canCloseWizard(step) ? undefined : onClose())}>
      <DialogPopup className="max-w-lg" showCloseButton={canCloseWizard(step)}>
        {step.step === "quit" ? (
          <QuitStep source={source} onCancel={onClose} onRechecked={recheckAfterQuit} />
        ) : step.step === "fullDiskAccess" ? (
          <FullDiskAccessStep
            source={source}
            onCancel={onClose}
            onOpenSettings={onOpenFullDiskAccessSettings}
            onCheck={
              onCheckFullDiskAccess ??
              (async () => {
                const refreshed = await onRefreshSource();
                return refreshed !== undefined && refreshed.unavailable === undefined;
              })
            }
            onGranted={step.resume === "import" ? runImport : recheckFullDiskAccess}
            stillRequired={step.checked === true}
          />
        ) : step.step === "importing" ? (
          <ImportingStep />
        ) : step.step === "loadingSites" ? (
          <LoadingSitesStep sourceName={source.name} />
        ) : step.step === "sites" ? (
          <SitesStep
            profileName={
              source.profiles.find((profile) => profile.directory === sourceProfileDirectory)
                ?.name ?? source.name
            }
            sites={step.sites}
            selected={siteSelection?.domains ?? []}
            onSelectedChange={(domains) => setSiteSelection({ sourceProfileDirectory, domains })}
            onBack={() => setStep({ step: "configure" })}
            onImport={runImport}
          />
        ) : step.step === "checking" ? (
          <CheckingStep sourceName={source.name} check={step.check} />
        ) : step.step === "done" ? (
          <DoneStep
            {...step}
            destinationEnvironmentName={destinationEnvironmentName}
            onClose={onClose}
          />
        ) : step.step === "blocked" ? (
          <BlockedStep
            source={source}
            reason={step.reason}
            onClose={onClose}
            onRetry={retryAction === undefined ? undefined : () => retryBlocked(retryAction)}
          />
        ) : (
          <ConfigureStep
            source={source}
            destinationEnvironmentName={destinationEnvironmentName}
            targetProfiles={targetProfiles}
            canCreateProfile={canCreateProfile}
            sourceProfileDirectory={sourceProfileDirectory}
            onSourceProfileChange={setSourceProfileDirectory}
            target={target}
            targetLocked={locked}
            onTargetChange={(selection) => {
              setTarget(selection);
              setTargetError(undefined);
            }}
            targetError={targetError}
            onCancel={onClose}
            onContinue={listSites}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function QuitStep({
  source,
  onCancel,
  onRechecked,
}: {
  readonly source: BrowserImportSource;
  readonly onCancel: () => void;
  readonly onRechecked: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Quit {source.name} to import</DialogTitle>
        <DialogDescription>
          {source.name} is open, so its cookies can&rsquo;t be read yet. Quit it, then continue.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onRechecked}>I&rsquo;ve quit it</Button>
      </DialogFooter>
    </>
  );
}

function cookieCountLabel(count: number | undefined): string | undefined {
  if (count === undefined) return undefined;
  if (count === 0) return "no cookies";
  return `${count.toLocaleString()} ${count === 1 ? "cookie" : "cookies"}`;
}

function cookieResultCount(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "cookie" : "cookies"}`;
}

/** A locked target has no picker to choose from, so it only says the profile is gone. */
function targetMissingCopy(targetLocked: boolean): string {
  return targetLocked
    ? "That profile is no longer available."
    : "That profile is no longer available. Choose where to import these cookies.";
}

type ConfigureStepProps = {
  readonly source: BrowserImportSource;
  readonly destinationEnvironmentName: string;
  readonly targetProfiles: ReadonlyArray<WizardTargetProfile>;
  readonly canCreateProfile: boolean;
  readonly sourceProfileDirectory: string;
  readonly onSourceProfileChange: (directory: string) => void;
  readonly target: WizardTargetSelection;
  readonly targetLocked: boolean;
  readonly targetError: string | undefined;
  readonly onTargetChange: (target: WizardTargetSelection) => void;
  readonly onCancel: () => void;
  readonly onContinue: () => void;
};

function FullDiskAccessStep({
  source,
  onCancel,
  onOpenSettings,
  onGranted,
  stillRequired,
  onCheck,
}: {
  readonly source: BrowserImportSource;
  readonly onCancel: () => void;
  readonly onOpenSettings: () => void | Promise<void>;
  readonly onCheck: () => Promise<boolean>;
  readonly onGranted: () => void;
  readonly stillRequired: boolean;
}) {
  const [opening, setOpening] = useState(false);
  const [openingError, setOpeningError] = useState<string | null>(null);
  const permission = usePermissionStatus(async () => ({ fullDiskAccess: await onCheck() }), {
    fullDiskAccess: false,
  });
  const allow = () => {
    if (opening) return;
    setOpening(true);
    setOpeningError(null);
    void Promise.resolve()
      .then(onOpenSettings)
      .catch(() => setOpeningError("Could not open System Settings. Try Allow again."))
      .finally(() => setOpening(false));
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Let T3 Code read {source.name}&rsquo;s cookies</DialogTitle>
        <DialogDescription>
          To import cookies from {source.name}, T3 Code needs Full Disk Access. Turn it on in System
          Settings, then come back to finish the import — you can revoke it again once the import is
          done.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <PermissionChecklist
          busy={opening}
          permissions={[
            {
              id: "fullDiskAccess",
              icon: (
                <HardDriveIcon
                  className="size-8 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              ),
              title: "Full Disk Access",
              description: `Read ${source.name}'s cookies for this import.`,
              granted: permission.status.fullDiskAccess,
              onAllow: () => void allow(),
            },
          ]}
        />
        {openingError || permission.error ? (
          <p role="status" className="mt-3 text-xs text-muted-foreground">
            {openingError ?? permission.error}
          </p>
        ) : null}
        {!permission.isReady(["fullDiskAccess"]) ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {stillRequired
              ? "Access is still required. Quit and reopen T3 Code if you just allowed it, then retry the import."
              : "If access doesn't update after you allow it, quit and reopen T3 Code, then retry the import."}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <PermissionContinueButton
          ready={permission.isReady(["fullDiskAccess"])}
          busy={opening}
          onClick={onGranted}
        >
          Continue
        </PermissionContinueButton>
      </DialogFooter>
    </>
  );
}
function ConfigureStep({
  source,
  destinationEnvironmentName,
  targetProfiles,
  canCreateProfile,
  sourceProfileDirectory,
  onSourceProfileChange,
  target,
  targetLocked,
  targetError,
  onTargetChange,
  onCancel,
  onContinue,
}: ConfigureStepProps) {
  const existingTarget =
    target.kind === "existing"
      ? targetProfiles.find((profile) => profile.id === target.profileId)
      : undefined;
  const targetMissing = target.kind === "existing" && existingTarget === undefined;
  // The "New profile" tile is unrendered once the cap is reached, so a target
  // chosen before that leaves nothing selected in "Into" — say so, the same
  // way a vanished existing target is explained.
  const targetUncreatable = target.kind === "new" && !canCreateProfile;
  const targetFeedback =
    targetError ??
    (targetMissing
      ? targetMissingCopy(targetLocked)
      : targetUncreatable
        ? "You've reached the profile limit. Choose an existing profile to import into."
        : undefined);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Import from {source.name}</DialogTitle>
        <DialogDescription>
          Choose which cookies to import for {destinationEnvironmentName}.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {/* Side by side when the dialog has room, stacked when it doesn't. */}
        <div
          className={cn(
            "flex flex-col gap-3",
            !targetLocked && "sm:flex-row sm:items-center sm:gap-4",
          )}
        >
          <section className="flex-1 space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              From
            </p>
            {source.profiles.map((profile) => (
              <SelectableTile
                key={profile.directory}
                selected={sourceProfileDirectory === profile.directory}
                title={profile.name}
                subtitle={cookieCountLabel(profile.cookieCount)}
                onSelect={() => onSourceProfileChange(profile.directory)}
              />
            ))}
          </section>
          {targetLocked ? (
            existingTarget ? (
              <p className="text-xs text-muted-foreground">Into {existingTarget.name}</p>
            ) : null
          ) : (
            <>
              <div className="flex shrink-0 items-center justify-center text-muted-foreground">
                <ArrowDownIcon className="size-4 sm:hidden" />
                <ArrowRightIcon className="hidden size-4 sm:block" />
              </div>
              <section className="flex-1 space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Into
                </p>
                {canCreateProfile ? (
                  <SelectableTile
                    selected={target.kind === "new"}
                    title="New profile"
                    subtitle="Created for these cookies"
                    onSelect={() => onTargetChange({ kind: "new" })}
                  />
                ) : null}
                {targetProfiles.map((profile) => (
                  <SelectableTile
                    key={profile.id}
                    selected={target.kind === "existing" && target.profileId === profile.id}
                    title={profile.name}
                    subtitle="Existing profile"
                    onSelect={() => onTargetChange({ kind: "existing", profileId: profile.id })}
                  />
                ))}
              </section>
            </>
          )}
        </div>
        {targetFeedback ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {targetFeedback}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          disabled={sourceProfileDirectory === "" || targetMissing || targetUncreatable}
          onClick={onContinue}
        >
          Continue
        </Button>
      </DialogFooter>
    </>
  );
}

function SelectableTile({
  selected,
  title,
  subtitle,
  onSelect,
}: {
  readonly selected: boolean;
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        selected
          ? "border-primary bg-primary/8"
          : "border-border/60 hover:border-border hover:bg-muted/40",
      )}
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">{title}</span>
        {subtitle ? (
          <span className="block truncate text-xs tabular-nums text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded-full border",
          selected ? "border-primary bg-primary text-primary-foreground" : "border-input",
        )}
      >
        {selected ? <CheckIcon className="size-2.5" /> : null}
      </span>
    </button>
  );
}

function ImportingStep() {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Importing cookies</DialogTitle>
        <DialogDescription>This may take a moment.</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex items-center gap-3 py-2">
          <Spinner size="md" tone="muted" />
          <span className="text-sm text-muted-foreground">Importing…</span>
        </div>
      </DialogPanel>
    </>
  );
}

function LoadingSitesStep({ sourceName }: { readonly sourceName: string }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Finding your sites</DialogTitle>
        <DialogDescription>Reading which sites {sourceName} has cookies for.</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex items-center gap-3 py-2">
          <Spinner size="md" tone="muted" />
          <span className="text-sm text-muted-foreground">Reading cookies…</span>
        </div>
      </DialogPanel>
    </>
  );
}

/** Past this many sites the list gets a filter field. */
const SITE_FILTER_THRESHOLD = 8;

const SENSITIVE_LABEL: Readonly<Record<NonNullable<BrowserImportSite["sensitive"]>, string>> = {
  banking: "Banking",
  email: "Email",
  signIn: "Sign-in",
};

/** Lets the user tick which sites' cookies come over. */
function SitesStep({
  profileName,
  sites,
  selected,
  onSelectedChange,
  onBack,
  onImport,
}: {
  readonly profileName: string;
  readonly sites: ReadonlyArray<BrowserImportSite>;
  readonly selected: ReadonlyArray<string>;
  readonly onSelectedChange: (domains: ReadonlyArray<string>) => void;
  readonly onBack: () => void;
  readonly onImport: () => void;
}) {
  const [query, setQuery] = useState("");
  const filterId = useId();
  const visible = filterSites(sites, query);
  const selectedSet = new Set(selected);
  const bulkLabels = siteBulkActionLabels(query);
  const { rows, hidden } = capSiteRows(visible);
  const setChecked = (domain: string, checked: boolean) =>
    onSelectedChange(
      checked ? [...selected, domain] : selected.filter((entry) => entry !== domain),
    );
  const selectMatches = () => onSelectedChange(selectMatchingSites(selected, sites, query));
  return (
    <>
      <DialogHeader>
        <DialogTitle>Choose sites to import</DialogTitle>
        <DialogDescription>
          Only the sites you tick come over. Banking, email and sign-in sites start unticked.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {sites.length === 0 ? (
          <p className="text-sm text-muted-foreground">{profileName} has no cookies to import.</p>
        ) : (
          <>
            {sites.length > SITE_FILTER_THRESHOLD ? (
              <div className="mb-3">
                <label htmlFor={filterId} className="sr-only">
                  Filter sites
                </label>
                <Input
                  id={filterId}
                  type="search"
                  placeholder="Filter sites"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
            ) : null}
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
                {selected.length} of {sites.length} selected
              </span>
              <div className="flex items-center gap-1">
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={visible.length === 0}
                  onClick={selectMatches}
                >
                  {bulkLabels.select}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={selected.length === 0}
                  onClick={() => onSelectedChange([])}
                >
                  {bulkLabels.clear}
                </Button>
              </div>
            </div>
            {visible.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">
                No sites match &ldquo;{query.trim()}&rdquo;.
              </p>
            ) : (
              <>
                <ul className="max-h-72 divide-y divide-border/60 overflow-y-auto rounded-lg border border-border/60">
                  {rows.map((entry) => (
                    <li key={entry.domain}>
                      <label className="flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors hover:bg-muted/40">
                        <Checkbox
                          checked={selectedSet.has(entry.domain)}
                          onCheckedChange={(checked) => setChecked(entry.domain, checked === true)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-foreground">
                            {entry.domain}
                          </span>
                          <span className="block truncate text-xs tabular-nums text-muted-foreground">
                            {cookieResultCount(entry.cookieCount)}
                            {entry.signedIn ? " · Signed in" : ""}
                          </span>
                        </span>
                        {entry.current || entry.sensitive ? (
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {[
                              entry.current ? "This site" : undefined,
                              entry.sensitive ? SENSITIVE_LABEL[entry.sensitive] : undefined,
                            ]
                              .filter((label) => label !== undefined)
                              .join(" · ")}
                          </span>
                        ) : null}
                      </label>
                    </li>
                  ))}
                </ul>
                {hidden > 0 ? (
                  <p className="mt-2 text-xs tabular-nums text-muted-foreground">
                    {hidden.toLocaleString()} more. Type to filter.
                  </p>
                ) : null}
              </>
            )}
          </>
        )}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button disabled={selected.length === 0} onClick={onImport}>
          {selected.length === 1 ? "Import 1 site" : `Import ${selected.length} sites`}
        </Button>
      </DialogFooter>
    </>
  );
}

function CheckingStep({
  sourceName,
  check,
}: {
  readonly sourceName: string;
  readonly check: "browser" | "fullDiskAccess";
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Checking {sourceName}</DialogTitle>
        <DialogDescription>
          {check === "fullDiskAccess"
            ? "Checking Full Disk Access."
            : "Checking whether the browser has closed."}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex items-center gap-3 py-2">
          <Spinner size="md" tone="muted" />
          <span className="text-sm text-muted-foreground">
            {check === "fullDiskAccess" ? "Checking access…" : "Checking…"}
          </span>
        </div>
      </DialogPanel>
    </>
  );
}

function DoneStep({
  imported,
  skipped,
  skippedDomains,
  targetName,
  destinationEnvironmentName,
  onClose,
}: {
  readonly imported: number;
  readonly skipped: number;
  readonly skippedDomains: ReadonlyArray<string>;
  readonly targetName: string;
  readonly destinationEnvironmentName: string;
  readonly onClose: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {imported > 0
            ? `Imported ${cookieResultCount(imported)}`
            : skipped > 0
              ? `Skipped ${cookieResultCount(skipped)}`
              : "No cookies found"}
        </DialogTitle>
        <DialogDescription>
          {imported > 0
            ? `Added to ${targetName} for ${destinationEnvironmentName}.${skipped > 0 ? ` ${cookieResultCount(skipped)} skipped.` : ""}`
            : skipped > 0
              ? `No cookies were imported for ${destinationEnvironmentName}.`
              : `There were no cookies to import for ${destinationEnvironmentName}.`}
        </DialogDescription>
      </DialogHeader>
      {skippedDomains.length > 0 ? (
        <DialogPanel>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Skipped
          </p>
          <p className="mt-1 text-sm text-foreground">{formatSkippedDomains(skippedDomains)}</p>
        </DialogPanel>
      ) : null}
      <DialogFooter>
        <DialogClose render={<Button />} onClick={onClose}>
          Done
        </DialogClose>
      </DialogFooter>
    </>
  );
}

function BlockedStep({
  source,
  reason,
  onClose,
  onRetry,
}: {
  readonly source: BrowserImportSource;
  readonly reason: keyof typeof BROWSER_IMPORT_FAILURE_COPY;
  readonly onClose: () => void;
  readonly onRetry: (() => void) | undefined;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Couldn&rsquo;t import from {source.name}</DialogTitle>
        <DialogDescription>{BROWSER_IMPORT_FAILURE_COPY[reason]}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
        {onRetry ? <Button onClick={onRetry}>Try again</Button> : null}
      </DialogFooter>
    </>
  );
}
