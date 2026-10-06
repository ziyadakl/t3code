import type { ProjectScript } from "@t3tools/contracts";
import { PlayIcon, ScrollTextIcon, SquareIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";

interface DevServerControlProps {
  script: ProjectScript;
  running: boolean;
  hasOutput: boolean;
  onStart: () => void;
  onStop: () => void;
  onShowOutput: () => void;
}

/**
 * Start/stop for the thread's dev server, plus a way back to its output. The
 * dev server runs in its own thread terminal, so the output panel is that
 * terminal and the running state is its live subprocess.
 */
export function DevServerControl({
  script,
  running,
  hasOutput,
  onStart,
  onStop,
  onShowOutput,
}: DevServerControlProps) {
  const toggleLabel = running ? `Stop ${script.name}` : `Start ${script.name}`;
  return (
    <div
      role="group"
      aria-label="Dev server"
      // A lone toggle is a plain row; the split surface only joins two halves.
      className={hasOutput ? THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS : "flex w-full"}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ThreadDetailsControl
              size="xs"
              variant="ghost"
              part={hasOutput ? "primary" : "row"}
              aria-label={toggleLabel}
              aria-pressed={running}
              onClick={running ? onStop : onStart}
            />
          }
        >
          {running ? (
            <SquareIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          ) : (
            <PlayIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          )}
          <span className="min-w-0 truncate">{toggleLabel}</span>
          {running ? (
            <span
              aria-hidden="true"
              className="ms-auto size-1.5 shrink-0 rounded-full bg-success"
            />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="top">{running ? "Stop the dev server" : script.command}</TooltipPopup>
      </Tooltip>
      {hasOutput ? (
        <>
          <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  size="sm"
                  variant="ghost"
                  part="secondary"
                  aria-label="Show dev server output"
                  onClick={onShowOutput}
                />
              }
            >
              <ScrollTextIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            </TooltipTrigger>
            <TooltipPopup side="top">Show output</TooltipPopup>
          </Tooltip>
        </>
      ) : null}
    </div>
  );
}
