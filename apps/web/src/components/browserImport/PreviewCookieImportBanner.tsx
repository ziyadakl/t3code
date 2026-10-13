import type { BrowserImportSource } from "@t3tools/contracts";
import { XIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Menu, MenuPopup, MenuTrigger } from "~/components/ui/menu";

import { BrowserImportSourceItems } from "./BrowserImportLauncher";
import { singleImportableSource } from "./browserImportLauncher.logic";

/**
 * One-line prompt above the preview page. With one browser on the machine the
 * button goes straight to its wizard; with more it offers the same choice as
 * the ⋮ menu. Choosing a browser or dismissing puts the prompt away for good.
 */
export function PreviewCookieImportBanner({
  sources,
  onChoose,
  onDismiss,
}: {
  readonly sources: ReadonlyArray<BrowserImportSource>;
  readonly onChoose: (source: BrowserImportSource) => void;
  readonly onDismiss: () => void;
}) {
  const only = singleImportableSource(sources);
  const choose = (source: BrowserImportSource) => {
    onDismiss();
    onChoose(source);
  };
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
      <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        Stay signed in to your sites by importing cookies from your browser.
      </p>
      {only ? (
        <Button size="xs" onClick={() => choose(only)}>
          Import cookies
        </Button>
      ) : (
        <Menu>
          <MenuTrigger render={<Button size="xs" />}>Import cookies</MenuTrigger>
          <MenuPopup align="end">
            <BrowserImportSourceItems sources={sources} onChoose={choose} />
          </MenuPopup>
        </Menu>
      )}
      <Button size="icon-xs" variant="ghost-muted" aria-label="Dismiss" onClick={onDismiss}>
        <XIcon />
      </Button>
    </div>
  );
}
