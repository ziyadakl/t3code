import type { BrowserImportSource, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, type ReactNode } from "react";

import {
  browserImportSupported,
  useBrowserImportDestination,
  useBrowserImportLauncher,
} from "./BrowserImportLauncher";
import { shouldShowCookieImportBanner } from "./browserImportLauncher.logic";
import { useCookieImportBannerDismissal } from "./cookieImportBannerDismissal";
import { PreviewCookieImportBanner } from "./PreviewCookieImportBanner";

/** What the ⋮ menu needs to offer "Import cookies from browser". */
export interface PreviewCookieImportMenu {
  readonly sources: ReadonlyArray<BrowserImportSource> | null;
  readonly loadSources: () => void;
  readonly onChoose: (source: BrowserImportSource) => void;
}

/**
 * Cookie import from inside the preview pane: the ⋮ menu entry, the one-time
 * banner, and the wizard both open. Imports land in the tab's own profile and
 * environment, and the tab reloads once they do so the user sees themselves
 * signed in.
 *
 * `available` is false where this machine's browsers are not the tab's: web
 * and remote clients have no bridge to read them, and a server-run tab keeps
 * its cookies in the environment's browser, not here. Incognito keeps nothing,
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

  // Listed once for the banner, and only while it could show.
  const bannerCandidate = usable && !dismissed;
  const { loadSources, sources } = launcher;
  const loadedForBanner = useRef(false);
  useEffect(() => {
    if (!bannerCandidate || loadedForBanner.current) return;
    loadedForBanner.current = true;
    loadSources();
  }, [bannerCandidate, loadSources]);

  if (!usable || destination === null) {
    return { menu: undefined, banner: null, wizard: launcher.wizard };
  }

  const onChoose = (source: BrowserImportSource) =>
    launcher.open({
      source,
      destination,
      initialTargetProfileId: input.profileId,
      currentUrl: input.currentUrl,
      onImported: (targetProfileId) => {
        if (targetProfileId === latest.current.profileId) latest.current.reload();
      },
    });

  const showBanner = shouldShowCookieImportBanner({
    importSupported: browserImportSupported,
    profilePersistent: input.profilePersistent,
    dismissed,
    sources,
  });

  return {
    menu: { sources, loadSources, onChoose },
    banner:
      showBanner && sources ? (
        <PreviewCookieImportBanner sources={sources} onChoose={onChoose} onDismiss={dismiss} />
      ) : null,
    wizard: launcher.wizard,
  };
}
