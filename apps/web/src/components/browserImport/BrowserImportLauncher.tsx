/**
 * The one place that runs a browser cookie import: it lists this machine's
 * browsers, hosts the import wizard, and does the work the wizard asks for.
 * Settings and the preview pane both open it, so the two entry points cannot
 * drift apart.
 *
 * @module BrowserImportLauncher
 */
import {
  BROWSER_PROFILE_MAX_COUNT,
  resolveBrowserProfiles,
  type BrowserImportSource,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useCallback, useRef, useState, type ReactNode } from "react";

import { clearBrowserProfileData } from "~/browser/browserProfileData";
import { resolveEnvironmentOptionLabel } from "~/components/BranchToolbar.logic";
import { previewBridge } from "~/components/preview/previewBridge";
import { BrowserImportWizard, type WizardTarget } from "./BrowserImportWizard";
import type { ImportOutcome } from "./browserImportWizard.logic";
import { MenuItem } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import {
  getClientSettings,
  persistClientSettingsUpdate,
  useClientSettings,
  useClientSettingsHydrated,
} from "~/hooks/useSettings";
import { readLocalApi } from "~/localApi";
import { useEnvironment, usePrimaryEnvironmentId } from "~/state/environments";

import {
  importFailureReason,
  importableBrowserSources,
  listSitesOutcome,
} from "./browserImportLauncher.logic";

/**
 * Whether this client can read the machine's browsers at all. Web and remote
 * clients have no desktop bridge, and an older desktop shell lacks the method.
 */
export const browserImportSupported = typeof previewBridge?.listBrowserImportSources === "function";

/** Where an import writes, captured when it opens so the copy and the write agree. */
export interface BrowserImportDestination {
  readonly environmentId: EnvironmentId;
  readonly environmentName: string;
}

/** The environment an import writes into, with the name the wizard shows for it. */
export function browserImportDestination(
  environment: { readonly environmentId: EnvironmentId; readonly label: string } | null,
  isPrimary: boolean,
): BrowserImportDestination | null {
  if (environment === null) return null;
  return {
    environmentId: environment.environmentId,
    environmentName: resolveEnvironmentOptionLabel({
      isPrimary,
      environmentId: environment.environmentId,
      runtimeLabel: environment.label,
    }),
  };
}

export function useBrowserImportDestination(
  environmentId: EnvironmentId,
): BrowserImportDestination | null {
  const environment = useEnvironment(environmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return browserImportDestination(
    environment && { environmentId, label: environment.label },
    environmentId === primaryEnvironmentId,
  );
}

export interface BrowserImportRequest {
  readonly source: BrowserImportSource;
  readonly destination: BrowserImportDestination;
  /** Existing profile to start "Into" on; the wizard's own default otherwise. */
  readonly initialTargetProfileId?: string | undefined;
  /** URL of the preview tab asking, so the wizard can put its site first. */
  readonly currentUrl?: string | undefined;
  /** Runs once cookies have landed in `targetProfileId`. */
  readonly onImported?: ((targetProfileId: string) => void) | undefined;
}

/** Thrown from the post-import settings updater when the cap was hit meanwhile. */
class ProfileLimitReachedError extends Error {
  constructor() {
    super("Browser profile limit reached.");
    this.name = "ProfileLimitReachedError";
  }
}

/**
 * Sources are listed lazily, by `loadSources`, when a menu opens: detection
 * touches the other browser's files, and the answer changes while the app is
 * running (quitting the browser clears `browserRunning`), so a value cached at
 * mount would go stale. A refresh keeps the last result on screen so a menu
 * does not reflow as it opens.
 */
export function useBrowserImportLauncher() {
  const userProfiles = useClientSettings((settings) => settings.browserProfiles);
  const settingsHydrated = useClientSettingsHydrated();
  const [sources, setSources] = useState<ReadonlyArray<BrowserImportSource> | null>(null);
  const [request, setRequest] = useState<BrowserImportRequest | null>(null);
  const importInFlightRef = useRef(false);
  const [importInFlight, setImportInFlight] = useState(false);

  const loadSources = useCallback(() => {
    if (!browserImportSupported || !previewBridge) return;
    void previewBridge
      .listBrowserImportSources()
      .then(setSources)
      .catch(() => setSources((previous) => previous ?? []));
  }, []);

  const isImportInFlight = useCallback(() => importInFlightRef.current, []);

  // A new profile is registered only once the import succeeds — the cookies
  // land in its partition first — so a blocked attempt never leaves an empty
  // profile behind.
  const runImport = async (
    current: BrowserImportRequest,
    input: {
      readonly sourceProfileDirectory: string;
      readonly target: WizardTarget;
      readonly domains: ReadonlyArray<string>;
    },
  ): Promise<ImportOutcome> => {
    const { source, destination } = current;
    if (!previewBridge) return { kind: "blocked", reason: "sessionUnavailable" };
    if (!settingsHydrated) return { kind: "blocked", reason: "sessionUnavailable" };
    const targetStillExists = () =>
      resolveBrowserProfiles(getClientSettings().browserProfiles).some(
        (profile) => profile.id === input.target.profileId,
      );
    if (input.target.kind === "existing" && !targetStillExists()) {
      return { kind: "blocked", reason: "readFailed" };
    }
    if (importInFlightRef.current) return { kind: "blocked", reason: "readFailed" };
    importInFlightRef.current = true;
    setImportInFlight(true);
    try {
      const result = await previewBridge.importBrowserCookies({
        environmentId: destination.environmentId,
        sourceId: source.id,
        sourceProfileDirectory: input.sourceProfileDirectory,
        targetProfileId: input.target.profileId,
        domains: input.domains,
      });
      if (input.target.kind === "existing" && !targetStillExists()) {
        return { kind: "blocked", reason: "readFailed" };
      }
      let targetName: string;
      if (input.target.kind === "new") {
        // Registered only when something actually came over: an import that
        // found no cookies should not leave a new, empty profile behind.
        if (result.imported > 0) {
          try {
            const persisted = await persistClientSettingsUpdate((settings) => {
              const existing = settings.browserProfiles.find(
                (profile) => profile.id === input.target.profileId,
              );
              if (existing) return settings;
              // The wizard refuses a new target at the cap, but the cap can be
              // reached while the import runs; the updater sees the newest
              // settings, so this is the check that holds.
              if (settings.browserProfiles.length >= BROWSER_PROFILE_MAX_COUNT) {
                throw new ProfileLimitReachedError();
              }
              const taken = new Set(
                resolveBrowserProfiles(settings.browserProfiles).map((profile) => profile.name),
              );
              let name = source.name;
              for (let index = 2; taken.has(name); index += 1) name = `${source.name} ${index}`;
              return {
                ...settings,
                browserProfiles: [
                  ...settings.browserProfiles,
                  { id: input.target.profileId, name, kind: "persistent" as const },
                ],
              };
            });
            targetName =
              persisted.browserProfiles.find((profile) => profile.id === input.target.profileId)
                ?.name ?? source.name;
          } catch (cause) {
            // This target id belongs only to the attempted new profile. Clear
            // its partition so a failed registration cannot strand imported
            // cookies behind a profile that disappears on restart.
            await clearBrowserProfileData(
              previewBridge,
              [destination.environmentId],
              input.target.profileId,
            ).catch(() => undefined);
            // Not a read failure: the cookies came over and were cleared again
            // because the profile could not be kept. Name that, in the same
            // token form `importFailureReason` recovers from a bridge error.
            const reason =
              cause instanceof ProfileLimitReachedError ? "profileLimitReached" : "profileNotSaved";
            throw new Error(`Importing cookies from ${source.id} failed: ${reason}.`, { cause });
          }
        } else {
          targetName = source.name;
        }
      } else {
        targetName = input.target.name;
      }
      if (result.imported > 0) current.onImported?.(input.target.profileId);
      return {
        kind: "imported",
        imported: result.imported,
        skipped: result.skipped,
        skippedDomains: result.skippedDomains,
        targetName,
      };
    } catch (cause) {
      return { kind: "blocked", reason: importFailureReason(cause) };
    } finally {
      importInFlightRef.current = false;
      setImportInFlight(false);
    }
  };

  // Re-checks a source's availability after the user quits the browser, and
  // keeps the cached list in step so every menu reflects it too.
  const refreshSource = async (
    sourceId: BrowserImportSource["id"],
  ): Promise<BrowserImportSource | undefined> => {
    if (!previewBridge) return undefined;
    try {
      const latest = await previewBridge.listBrowserImportSources();
      setSources(latest);
      return latest.find((source) => source.id === sourceId);
    } catch {
      return undefined;
    }
  };

  const listSites = (current: BrowserImportRequest, sourceProfileDirectory: string) => {
    if (!previewBridge?.listBrowserImportSites) {
      return Promise.resolve({ kind: "blocked", reason: "sessionUnavailable" } as const);
    }
    return listSitesOutcome(
      previewBridge.listBrowserImportSites({
        sourceId: current.source.id,
        sourceProfileDirectory,
        ...(current.currentUrl ? { currentUrl: current.currentUrl } : {}),
      }),
    );
  };

  // Incognito is never a target: it keeps nothing past the app closing.
  const targetProfiles = resolveBrowserProfiles(userProfiles)
    .filter((profile) => profile.kind !== "incognito")
    .map((profile) => ({ id: profile.id, name: profile.name }));
  const atProfileLimit = userProfiles.length >= BROWSER_PROFILE_MAX_COUNT;

  const wizard: ReactNode = request ? (
    <BrowserImportWizard
      source={request.source}
      destinationEnvironmentName={request.destination.environmentName}
      targetProfiles={targetProfiles}
      canCreateProfile={settingsHydrated && !atProfileLimit}
      initialTargetProfileId={request.initialTargetProfileId}
      onListSites={(sourceProfileDirectory) => listSites(request, sourceProfileDirectory)}
      onImport={(input) => runImport(request, input)}
      onRefreshSource={() => refreshSource(request.source.id)}
      onCheckFullDiskAccess={
        window.desktopBridge?.checkSystemPermission
          ? () => window.desktopBridge!.checkSystemPermission!("full-disk-access")
          : undefined
      }
      onOpenFullDiskAccessSettings={async () => {
        // Rejects outside the desktop shell (and on shells that predate the
        // method), so the one toast covers every way the link can fail.
        await readLocalApi()
          ?.shell.openSystemSettings("full-disk-access")
          .catch(() => {
            toastManager.add({
              type: "error",
              title: "Could not open System Settings",
              description: "Open Privacy & Security → Full Disk Access manually.",
            });
          });
      }}
      onClose={() => setRequest(null)}
    />
  ) : null;

  return {
    sources,
    loadSources,
    importInFlight,
    isImportInFlight,
    open: setRequest,
    wizard,
  };
}

/**
 * Menu rows for choosing a browser, shared by every import menu. Every source
 * is a plain row — running, needs-permission and ready all look the same here;
 * the wizard picks up whatever state the source is in and walks the user
 * forward from there.
 */
export function BrowserImportSourceItems({
  sources,
  disabled = false,
  onChoose,
}: {
  readonly sources: ReadonlyArray<BrowserImportSource> | null;
  readonly disabled?: boolean;
  readonly onChoose: (source: BrowserImportSource) => void;
}) {
  if (sources === null) return <MenuItem disabled>Looking for browsers…</MenuItem>;
  const importable = importableBrowserSources(sources);
  if (importable.length === 0) return <MenuItem disabled>No supported browsers found</MenuItem>;
  return importable.map((source) => (
    <MenuItem key={source.id} disabled={disabled} onClick={() => onChoose(source)}>
      {source.name}
    </MenuItem>
  ));
}
