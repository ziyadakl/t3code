import type { BrowserImportSource } from "@t3tools/contracts";
import { XIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Menu, MenuPopup, MenuTrigger } from "~/components/ui/menu";

import { BrowserImportSourceItems } from "./BrowserImportLauncher";
import { singleImportableSource } from "./browserImportLauncher.logic";

/**
 * One-line prompt above the preview page. With one browser on the machine the
 * button goes straight to its wizard; with more it offers the same choice as
 * the ⋮ menu. The caller puts it away for good once dismissed or an import
 * lands.
 */
export function PreviewCookieImportBanner({
  sources,
  loadSources,
  onChoose,
  onDismiss,
}: {
  readonly sources: ReadonlyArray<BrowserImportSource>;
  readonly loadSources: () => void;
  readonly onChoose: (source: BrowserImportSource) => void;
  readonly onDismiss: () => void;
}) {
  const only = singleImportableSource(sources);
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
      <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        Stay signed in to your sites by importing cookies from your browser.
      </p>
      {only ? (
        <Button size="xs" onClick={() => onChoose(only)}>
          Import cookies
        </Button>
      ) : (
        <Menu onOpenChange={(open) => open && loadSources()}>
          <MenuTrigger render={<Button size="xs" />}>Import cookies</MenuTrigger>
          <MenuPopup align="end">
            <BrowserImportSourceItems sources={sources} onChoose={onChoose} />
          </MenuPopup>
        </Menu>
      )}
      <Button size="icon-xs" variant="ghost-muted" aria-label="Dismiss" onClick={onDismiss}>
        <XIcon />
      </Button>
    </div>
  );
}
