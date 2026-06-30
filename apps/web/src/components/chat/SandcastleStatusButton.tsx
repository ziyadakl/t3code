import { type EnvironmentId } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { CastleIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import {
  useSandcastleStatuses,
  statusKey,
  type ProjectRef,
} from "../sandcastle/useSandcastleStatuses";
import { deriveBanner, type BannerKind } from "../sandcastle/sandcastleView";
import { LiveDot } from "../sandcastle/LiveDot";
import { SandcastleProjectDetail } from "../sandcastle/SandcastleProjectDetail";
import { cn } from "~/lib/utils";

interface SandcastleStatusButtonProps {
  environmentId: EnvironmentId;
  projectId: string | null;
  projectCwd: string | null;
}

/**
 * Solid dot colour for a non-live banner kind. "live" is handled separately by
 * the pulsing LiveDot, so its branch here is unused but kept for exhaustiveness.
 */
function statusDotClass(kind: BannerKind): string {
  switch (kind) {
    case "stale":
    case "outdated":
      return "bg-warning";
    case "error":
      return "bg-destructive";
    case "done":
      return "bg-info";
    case "stopped":
    case "waiting":
      return "bg-muted-foreground";
    case "live":
      return "bg-success";
  }
}

/**
 * Toolbar button for Sandcastle-enabled projects: shows the loop's live/stopped
 * indicator inline and opens the per-project Sandcastle viewer in a dialog.
 *
 * Reuses the same status feed + banner derivation as the /sandcastle route, so
 * the indicator matches the dashboard exactly. Renders nothing for projects that
 * aren't Sandcastle-enabled (no `.sandcastle/` dir), keeping the toolbar clean.
 */
export function SandcastleStatusButton({
  environmentId,
  projectId,
  projectCwd,
}: SandcastleStatusButtonProps) {
  const [open, setOpen] = useState(false);

  const refs = useMemo<ProjectRef[]>(
    () => (projectCwd ? [{ environmentId, cwd: projectCwd }] : []),
    [environmentId, projectCwd],
  );
  const statuses = useSandcastleStatuses(refs);

  const value = projectCwd ? statuses.get(statusKey(environmentId, projectCwd)) : undefined;
  const entry = value?.entry;

  // Only surface the button once we know the project is Sandcastle-enabled.
  if (!projectId || !entry?.hasSandcastleDir) return null;

  const banner = deriveBanner(entry, value!.serverNow);
  const snap = entry.snapshot;
  const tooltipText =
    banner.kind === "live" && snap?.activity
      ? `Sandcastle: Live · ${snap.activity}`
      : `Sandcastle: ${banner.text}`;

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={`Sandcastle: ${banner.text}`}
              className="shrink-0"
              onClick={() => {
                setOpen(true);
              }}
              size="xs"
              variant="outline"
            >
              <CastleIcon className="size-3.5" />
              {banner.kind === "live" ? (
                <LiveDot />
              ) : (
                <span
                  aria-hidden="true"
                  className={cn("size-2 shrink-0 rounded-full", statusDotClass(banner.kind))}
                />
              )}
            </Button>
          }
        />
        <TooltipPopup side="bottom">{tooltipText}</TooltipPopup>
      </Tooltip>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="flex h-[80vh] max-w-3xl flex-col p-0">
          <DialogTitle className="sr-only">Sandcastle viewer</DialogTitle>
          <SandcastleProjectDetail environmentId={environmentId} projectId={projectId} embedded />
        </DialogPopup>
      </Dialog>
    </>
  );
}
