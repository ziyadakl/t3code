import type { BrowserImportSource, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { toastManager } from "~/components/ui/toast";

import {
  browserImportSupported,
  useBrowserImportDestination,
  useBrowserImportLauncher,
} from "./BrowserImportLauncher";
import {
  chooseFromBanner,
  importableBrowserSources,
  oncePerSession,
  previewImportLanded,
  shouldShowCookieImportBanner,
} from "./browserImportLauncher.logic";
import { useCookieImportBannerDismissal } from "./cookieImportBannerDismissal";
import { PreviewCookieImportBanner } from "./PreviewCookieImportBanner";

/**
 * Once the banner has something to offer, that barely changes while the app
 * runs, so one listing serves every preview pane this session. A listing with
 * nothing to offer is not kept: a browser installed later shows the banner on
 * the next pane. Menus, and the banner's own button, still list fresh, since
 * the state of each browser does change.
 */
const listSourcesForBanner = oncePerSession(
  async () => {
    if (!previewBridge) return [];
    return previewBridge.listBrowserImportSources();
  },
  (sources) => importableBrowserSources(sources).length > 0,
);

/** What the ⋮ menu needs to offer "Import cookies from browser". */
export interface PreviewCookieImportMenu {
  readonly sources: ReadonlyArray<BrowserImportSource> | null;
  readonly loadSources: () => void;
  readonly onChoose: (source: BrowserImportSource) => void;
}

/**
 * Cookie import from inside the preview pane: the ⋮ menu entry, the one-time
 * banner, and the wizard both open. Imports land in the tab's own profile and
 * environment, with no other choice, and the tab reloads once they do so the
 * user sees themselves signed in. The banner goes away for good when the user
 * closes it or an import lands; backing out of the wizard keeps it.
 *
 * `available` is false where this machine's browsers are not the tab's: web
 * and remote clients have no bridge to read them, and a streamed server tab
 * keeps its cookies in the environment's browser, not here. Incognito keeps nothing,
 * so it gets neither entry.
 */
export function usePreviewCookieImport(input: {
  readonly available: boolean;
  readonly environmentId: EnvironmentId;
  readonly profileId: string;
  readonly profilePersistent: boolean;
  readonly currentUrl: string | undefined;
  readonly reload: () => void;
}): {
  readonly menu: PreviewCookieImportMenu | undefined;
  readonly banner: ReactNode;
  readonly wizard: ReactNode;
} {
  const launcher = useBrowserImportLauncher();
  const destination = useBrowserImportDestination(input.environmentId);
  const { dismissed, dismiss } = useCookieImportBannerDismissal();
  const usable =
    browserImportSupported && input.available && input.profilePersistent && destination !== null;

  // The import outlives the render that opened it; the reload must target the
  // tab and profile the pane shows when it finishes.
  const latest = useRef(input);
  useEffect(() => {
    latest.current = input;
  });

  // Listed for the banner only while it could show.
  const bannerCandidate = usable && !dismissed;
  const [bannerSources, setBannerSources] = useState<ReadonlyArray<BrowserImportSource> | null>(
    null,
  );
  useEffect(() => {
    if (!bannerCandidate) return;
    let current = true;
    void listSourcesForBanner().then(
      (listed) => current && setBannerSources(listed),
      () => current && setBannerSources([]),
    );
    return () => {
      current = false;
    };
  }, [bannerCandidate]);

  const { loadSources, sources } = launcher;
  if (!usable || destination === null) {
    return { menu: undefined, banner: null, wizard: launcher.wizard };
  }

  const onChoose = (source: BrowserImportSource) =>
    launcher.open({
      source,
      destination,
      initialTargetProfileId: input.profileId,
      targetLocked: true,
      currentUrl: input.currentUrl,
      onImported: (targetProfileId) => {
        const landed = previewImportLanded(targetProfileId, latest.current.profileId);
        if (landed.dismissBanner) dismiss();
        if (landed.reloadTab) latest.current.reload();
      },
    });

  // The banner's sources may be from launch; open the wizard from a fresh
  // listing so availability and profiles are as they are now.
  const onChooseFromBanner = (chosen: BrowserImportSource) => {
    const bridge = previewBridge;
    if (!bridge) return;
    void chooseFromBanner(chosen.id, {
      listSources: () => bridge.listBrowserImportSources(),
      wizardOpen: launcher.isWizardOpen,
      open: onChoose,
      refreshBanner: (fresh) => {
        setBannerSources(fresh);
        loadSources();
      },
      notifyFailure: () =>
        toastManager.add({ type: "error", title: "Couldn't check your browsers. Try again." }),
    });
  };

  const showBanner = shouldShowCookieImportBanner({ dismissed, sources: bannerSources });

  return {
    menu: { sources, loadSources, onChoose },
    banner:
      showBanner && bannerSources ? (
        <PreviewCookieImportBanner
          sources={sources ?? bannerSources}
          loadSources={loadSources}
          onChoose={onChooseFromBanner}
          onDismiss={dismiss}
        />
      ) : null,
    wizard: launcher.wizard,
  };
}
