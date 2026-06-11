import { type MessageId } from "@t3tools/contracts";
import { type ReactElement } from "react";
import { FileClockIcon, Undo2Icon } from "lucide-react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";

// ---------------------------------------------------------------------------
// Unified Claude-CLI-style rewind menu (ADR-0002). Targets are USER prompts.
//
//   * "Restore conversation only" — default, NO confirmation. Non-destructive:
//     jump the session back to that prompt and continue in the same thread.
//   * "Also restore files" — confirmation-gated (it overwrites the working
//     tree). Shown ONLY when a git checkpoint exists for that point.
//
// Both the per-message undo button and the ESC-ESC picker route through this
// single menu so the two entry points share one action path.
// ---------------------------------------------------------------------------

export interface RewindMenuActions {
  /** Conversation-only rewind. Default item; never confirms. */
  readonly onRestoreConversation: (messageId: MessageId) => void;
  /** Rewind conversation + restore the working tree. Confirms before running. */
  readonly onRestoreConversationAndFiles: (messageId: MessageId) => void;
}

interface RewindMenuProps extends RewindMenuActions {
  readonly messageId: MessageId;
  /** Whether a git checkpoint exists for this point (gates "Also restore files"). */
  readonly hasCheckpoint: boolean;
  readonly disabled?: boolean;
  /** Custom trigger element. Defaults to the small undo icon button. */
  readonly trigger?: ReactElement;
  /** Called after either action is chosen (e.g. to close a host picker dialog). */
  readonly onChosen?: () => void;
}

export function RewindMenu({
  messageId,
  hasCheckpoint,
  disabled,
  trigger,
  onRestoreConversation,
  onRestoreConversationAndFiles,
  onChosen,
}: RewindMenuProps) {
  return (
    <Menu>
      {trigger ? (
        <MenuTrigger disabled={disabled} render={trigger} />
      ) : (
        <MenuTrigger
          disabled={disabled}
          render={
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={disabled}
              aria-label="Rewind to this prompt"
              title="Rewind to this prompt"
            />
          }
        >
          <Undo2Icon className="size-3" />
        </MenuTrigger>
      )}
      <MenuPopup align="end">
        <MenuItem
          onClick={() => {
            onRestoreConversation(messageId);
            onChosen?.();
          }}
        >
          <Undo2Icon className="size-4 shrink-0" />
          Restore conversation only
        </MenuItem>
        {hasCheckpoint ? (
          <>
            <MenuSeparator />
            <MenuItem
              onClick={() => {
                onRestoreConversationAndFiles(messageId);
                onChosen?.();
              }}
            >
              <FileClockIcon className="size-4 shrink-0" />
              Also restore files
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

// ---------------------------------------------------------------------------
// ESC-ESC rewind picker — lists prior user prompts (most-recent-first). Each
// row is a RewindMenu trigger, so selecting one opens the same unified menu.
// ---------------------------------------------------------------------------

export interface RewindPickerPrompt {
  readonly messageId: MessageId;
  readonly text: string;
  readonly createdAt: string;
  /** Whether a git checkpoint exists for this prompt's turn. */
  readonly hasCheckpoint: boolean;
}

interface RewindPickerProps extends RewindMenuActions {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Prior user prompts, already ordered most-recent-first. */
  readonly prompts: ReadonlyArray<RewindPickerPrompt>;
}

const REWIND_PICKER_PREVIEW_LENGTH = 140;

function previewPromptText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) {
    return "(empty prompt)";
  }
  return collapsed.length > REWIND_PICKER_PREVIEW_LENGTH
    ? `${collapsed.slice(0, REWIND_PICKER_PREVIEW_LENGTH)}…`
    : collapsed;
}

export function RewindPicker({
  open,
  onOpenChange,
  prompts,
  onRestoreConversation,
  onRestoreConversationAndFiles,
}: RewindPickerProps) {
  const close = () => onOpenChange(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Rewind to an earlier prompt</DialogTitle>
          <DialogDescription>
            Jump back to a previous prompt and continue from there. Restoring the conversation is
            non-destructive — your files stay put unless you choose to restore them too.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-2">
          {prompts.length === 0 ? (
            <div className="text-sm text-muted-foreground">No earlier prompts to rewind to.</div>
          ) : null}
          {prompts.map((prompt) => (
            <RewindMenu
              key={prompt.messageId}
              messageId={prompt.messageId}
              hasCheckpoint={prompt.hasCheckpoint}
              onRestoreConversation={onRestoreConversation}
              onRestoreConversationAndFiles={onRestoreConversationAndFiles}
              onChosen={close}
              trigger={
                <button
                  type="button"
                  className="w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="line-clamp-2 text-foreground">{previewPromptText(prompt.text)}</div>
                  {prompt.hasCheckpoint ? (
                    <div className="mt-0.5 text-xs text-muted-foreground">checkpoint available</div>
                  ) : null}
                </button>
              }
            />
          ))}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
