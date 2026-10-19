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
import { useRef, useState, type ReactNode } from "react";

import { resolveEnvironmentOptionLabel } from "~/components/BranchToolbar.logic";
import { previewBridge } from "~/components/preview/previewBridge";
import { BrowserImportWizard } from "./BrowserImportWizard";
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

import { importableBrowserSources, listSitesOutcome } from "./browserImportLauncher.logic";
import {
  runBrowserImport,
  type BrowserImportChoice,
  type BrowserImportRun,
  type BrowserProfileStore,
} from "./runBrowserImport";

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

export interface BrowserImportRequest extends BrowserImportRun {
  readonly destination: BrowserImportDestination;
  /** Existing profile to start "Into" on; the wizard's own default otherwise. */
  readonly initialTargetProfileId?: string | undefined;
  /** Import into `initialTargetProfileId` only, with no "Into" choice. */
  readonly targetLocked?: boolean | undefined;
  /** URL of the preview tab asking, so the wizard can put its site first. */
  readonly currentUrl?: string | undefined;
}

/** The saved browser profiles as client settings hold them. */
const browserProfileStore: BrowserProfileStore = {
  current: () => getClientSettings().browserProfiles,
  update: async (update) =>
    (
      await persistClientSettingsUpdate((settings) => {
        const browserProfiles = update(settings.browserProfiles);
        return browserProfiles === settings.browserProfiles
          ? settings
          : { ...settings, browserProfiles };
      })
    ).browserProfiles,
};

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
  // Each open gets its own id, and the wizard is keyed on it, so a new request
  // remounts the wizard rather than swapping the source under a live one.
  const [opened, setOpened] = useState<{
    readonly id: number;
    readonly request: BrowserImportRequest;
  } | null>(null);
  const request = opened?.request ?? null;
  const lastOpenId = useRef(0);
  const wizardOpenRef = useRef(false);
  const open = (next: BrowserImportRequest) => {
    lastOpenId.current += 1;
    wizardOpenRef.current = true;
    setOpened({ id: lastOpenId.current, request: next });
  };
  const close = () => {
    wizardOpenRef.current = false;
    setOpened(null);
  };
  /** Whether a wizard is open now, current even inside a callback from an older render. */
  const isWizardOpen = () => wizardOpenRef.current;
  const importInFlightRef = useRef(false);
  const [importInFlight, setImportInFlight] = useState(false);

  const loadSources = () => {
    if (!browserImportSupported || !previewBridge) return;
    void previewBridge
      .listBrowserImportSources()
      .then(setSources)
      .catch(() => setSources((previous) => previous ?? []));
  };

  const isImportInFlight = () => importInFlightRef.current;

  const runImport = async (
    current: BrowserImportRequest,
    choice: BrowserImportChoice,
  ): Promise<ImportOutcome> => {
    if (!previewBridge || !settingsHydrated)
      return { kind: "blocked", reason: "sessionUnavailable" };
    if (importInFlightRef.current) return { kind: "blocked", reason: "readFailed" };
    importInFlightRef.current = true;
    setImportInFlight(true);
    // `.finally` rather than try/finally: React Compiler cannot compile a
    // `finally` without a `catch`.
    return runBrowserImport(previewBridge, browserProfileStore, current, choice).finally(() => {
      importInFlightRef.current = false;
      setImportInFlight(false);
    });
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
      key={opened?.id}
      source={request.source}
      destinationEnvironmentName={request.destination.environmentName}
      targetProfiles={targetProfiles}
      canCreateProfile={settingsHydrated && !atProfileLimit}
      initialTargetProfileId={request.initialTargetProfileId}
      targetLocked={request.targetLocked}
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
      onClose={close}
    />
  ) : null;

  return {
    sources,
    loadSources,
    importInFlight,
    isImportInFlight,
    open,
    isWizardOpen,
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
