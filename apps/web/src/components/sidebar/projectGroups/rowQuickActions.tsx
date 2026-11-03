/**
 * Fork (grouped layout): the hover quick actions (discard draft, snooze,
 * settle) of a compact active row under a project group header. The card keeps
 * upstream's inline controls; `SidebarThreadRow` renders `CompactRowSlot` in
 * the status slot of a compact row.
 */
import type { TimestampFormat } from "@t3tools/contracts/settings";
import type { EnvironmentId } from "@t3tools/contracts";
import { CheckIcon, XIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { cn } from "~/lib/utils";
import type { SnoozePreset } from "../../Sidebar.snooze";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { SnoozeMenuButton, type SidebarSweepAction } from "../SidebarThreadRow";

export type SidebarRowQuickAction = "discard-draft" | "snooze" | "settle" | "unsettle" | "wake";

/**
 * The hover quick actions a thread row offers, in display order. Decided by the
 * row's section action alone, never by its look, so a slim grouped row offers
 * exactly what the full card does.
 */
export function resolveSidebarRowQuickActions(input: {
  variantAction: SidebarSweepAction;
  settlementSupported: boolean;
  snoozeSupported: boolean;
  /** Capability, operator access and thread state all allow a snooze now. */
  canSnoozeNow: boolean;
  hasUnsentDraft: boolean;
}): readonly SidebarRowQuickAction[] {
  if (input.variantAction === "unsnooze") return input.snoozeSupported ? ["wake"] : [];
  if (input.variantAction === "unsettle") return input.settlementSupported ? ["unsettle"] : [];
  const actions: SidebarRowQuickAction[] = [];
  if (input.hasUnsentDraft) actions.push("discard-draft");
  if (input.canSnoozeNow) actions.push("snooze");
  if (input.settlementSupported) actions.push("settle");
  return actions;
}

// The status label sitting under the quick actions leaves the flow and fades
// while the row is hovered or an action has keyboard focus, so the actions take
// its place in the same slot. Needs a `group/sidebar-status-slot` parent.
export const STATUS_LABEL_YIELDS_TO_QUICK_ACTIONS =
  "pointer-events-none group-has-[:focus-visible]/sidebar-status-slot:absolute group-has-[:focus-visible]/sidebar-status-slot:right-0 group-has-[:focus-visible]/sidebar-status-slot:opacity-0 group-any-hover/sidebar-row:absolute group-any-hover/sidebar-row:right-0 group-any-hover/sidebar-row:opacity-0";

/**
 * An active thread row's hover quick actions (discard draft, snooze, settle),
 * of a compact grouped row (the card keeps upstream's inline controls). Hidden at rest; cross-fades in
 * over the row's status label on hover or keyboard focus, and stays pinned
 * while the snooze menu is open. Slim rows show the settle icon without its label.
 */
function SidebarRowQuickActions(props: {
  actions: readonly SidebarRowQuickAction[];
  slim: boolean;
  snoozeMenuOpen: boolean;
  onSnoozeMenuOpenChange: (open: boolean) => void;
  onSnooze: (preset: Pick<SnoozePreset, "snoozedUntil">) => void;
  timestampFormat: TimestampFormat;
  environmentId: EnvironmentId;
  onDiscardDraft: (event: ReactMouseEvent) => void;
  onSettle: (event: ReactMouseEvent) => void;
  onActionPointerDown: (event: ReactPointerEvent) => void;
}) {
  const { actions } = props;
  if (actions.length === 0) return null;
  return (
    <span
      className={cn(
        // Mouse clicks leave Settle focused; focus-within would pin controls over
        // the status label after the pointer leaves. Use focus-visible instead.
        "pointer-events-none absolute inset-y-0 right-0 flex items-stretch self-stretch opacity-0 transition-opacity has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:static has-[:focus-visible]:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:static group-any-hover/sidebar-row:opacity-100",
        props.snoozeMenuOpen && "pointer-events-auto static opacity-100",
      )}
    >
      {actions.includes("discard-draft") ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Discard draft"
                onClick={props.onDiscardDraft}
                className="inline-flex cursor-pointer items-center rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
              />
            }
          >
            <XIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">Discard draft</TooltipPopup>
        </Tooltip>
      ) : null}
      {actions.includes("snooze") ? (
        <SnoozeMenuButton
          open={props.snoozeMenuOpen}
          onOpenChange={props.onSnoozeMenuOpenChange}
          onSnooze={props.onSnooze}
          timestampFormat={props.timestampFormat}
          environmentId={props.environmentId}
        />
      ) : null}
      {actions.includes("settle") ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Settle thread"
                onClick={props.onSettle}
                onPointerDown={props.onActionPointerDown}
                className="-mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
              />
            }
          >
            <CheckIcon className="size-3.5" />
            {props.slim ? null : "Settle"}
          </TooltipTrigger>
          <TooltipPopup>Settle thread</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}

/** The quick actions of a compact active row, in its status slot. */
export function CompactRowSlot(props: {
  variantAction: SidebarSweepAction;
  settlementSupported: boolean;
  snoozeSupported: boolean;
  canSnoozeNow: boolean;
  hasUnsentDraft: boolean;
  snoozeMenuOpen: boolean;
  onSnoozeMenuOpenChange: (open: boolean) => void;
  onSnooze: (preset: Pick<SnoozePreset, "snoozedUntil">) => void;
  timestampFormat: TimestampFormat;
  environmentId: EnvironmentId;
  onDiscardDraft: (event: ReactMouseEvent) => void;
  onSettle: (event: ReactMouseEvent) => void;
  onActionPointerDown: (event: ReactPointerEvent) => void;
}) {
  const { variantAction, settlementSupported, snoozeSupported, canSnoozeNow, hasUnsentDraft } =
    props;
  return (
    <SidebarRowQuickActions
      actions={resolveSidebarRowQuickActions({
        variantAction,
        settlementSupported,
        snoozeSupported,
        canSnoozeNow,
        hasUnsentDraft,
      })}
      slim
      snoozeMenuOpen={props.snoozeMenuOpen}
      onSnoozeMenuOpenChange={props.onSnoozeMenuOpenChange}
      onSnooze={props.onSnooze}
      timestampFormat={props.timestampFormat}
      environmentId={props.environmentId}
      onDiscardDraft={props.onDiscardDraft}
      onSettle={props.onSettle}
      onActionPointerDown={props.onActionPointerDown}
    />
  );
}
