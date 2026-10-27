import type { MessageId } from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { useEffect, useEffectEvent, useId, useState, type KeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { CommandFooter } from "../ui/command";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Kbd, KbdGroup } from "../ui/kbd";
import {
  initialRewindIndex,
  moveRewindSelection,
  rewindItemLabel,
  type RewindPickerItem,
} from "./RewindPicker.logic";

export interface RewindPickerProps {
  readonly open: boolean;
  /** The thread's rewindable user messages, oldest first. Open only when non-empty. */
  readonly items: ReadonlyArray<RewindPickerItem>;
  /** The user picked a message: rewind to before it. */
  readonly onChoose: (messageId: MessageId) => void;
  /** Escape, the close button or a click outside. */
  readonly onCancel: () => void;
}

/**
 * The double-Escape rewind picker. Like Claude Code's, it lists earlier user
 * messages oldest first with the newest selected at the bottom, next to the
 * composer the user just left; Up walks back through the conversation.
 */
export function RewindPicker(props: RewindPickerProps) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onCancel();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Rewind</DialogTitle>
          <DialogDescription>Pick a message to go back to before it.</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so each opening starts on the newest message. The
            listbox is the popup's first tabbable element, so it takes the initial focus. */}
        <RewindPickerList items={props.items} onChoose={props.onChoose} />
        <CommandFooter className="max-sm:hidden">
          <div className="flex items-center gap-3">
            <KbdGroup>
              <Kbd>
                <ArrowUpIcon />
              </Kbd>
              <Kbd>
                <ArrowDownIcon />
              </Kbd>
              <span>Navigate</span>
            </KbdGroup>
            <KbdGroup>
              <Kbd>Enter</Kbd>
              <span>Rewind</span>
            </KbdGroup>
          </div>
          <KbdGroup>
            <Kbd>Esc</Kbd>
            <span>Close</span>
          </KbdGroup>
        </CommandFooter>
      </DialogPopup>
    </Dialog>
  );
}

const NAVIGATION_KEYS = new Set(["ArrowUp", "ArrowDown", "Home", "End"]);

function RewindPickerList(props: {
  items: ReadonlyArray<RewindPickerItem>;
  onChoose: (messageId: MessageId) => void;
}) {
  const { items } = props;
  const idPrefix = useId();
  const [index, setIndex] = useState(() => initialRewindIndex(items.length));
  // The list can shrink while open (a rewind landed elsewhere); never point past it.
  const selected = Math.min(index, items.length - 1);
  const optionId = (position: number) => `${idPrefix}-option-${position}`;

  // Chrome's scrollIntoView returns a promise; never hand it to React.
  const scrollToOption = (position: number): void => {
    void document.getElementById(optionId(position))?.scrollIntoView({ block: "nearest" });
  };

  const select = (next: number) => {
    setIndex(next);
    scrollToOption(next);
  };

  // Once, on open: the newest message is last, so a long thread would open scrolled away from it.
  const scrollToNewest = useEffectEvent(() => scrollToOption(initialRewindIndex(items.length)));
  // oxlint-disable-next-line t3code/react-effect-budget -- scrolls the newest option into view once on open, an imperative DOM scroll with no render-time form
  useEffect(() => {
    scrollToNewest();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter") {
      const item = items[selected];
      if (!item) return;
      event.preventDefault();
      props.onChoose(item.messageId);
      return;
    }
    if (!NAVIGATION_KEYS.has(event.key)) return;
    event.preventDefault();
    select(moveRewindSelection(selected, event.key, items.length));
  };

  return (
    <DialogPanel>
      <div
        role="listbox"
        aria-label="Messages"
        aria-activedescendant={items[selected] ? optionId(selected) : undefined}
        tabIndex={0}
        className="flex flex-col gap-px outline-none"
        onKeyDown={onKeyDown}
      >
        {items.map((item, position) => {
          const active = position === selected;
          const time = formatRelativeTimeLabel(item.createdAt);
          return (
            <div
              key={item.messageId}
              id={optionId(position)}
              role="option"
              aria-selected={active}
              className={cn(
                "flex min-h-8 cursor-pointer select-none items-center gap-3 rounded-sm px-2 py-1.5 text-base sm:min-h-7 sm:text-sm",
                active ? "bg-accent text-accent-foreground" : "text-foreground",
              )}
              // Move, not enter: scrolling the list under a still pointer must not steal the selection.
              onMouseMove={() => {
                if (!active) setIndex(position);
              }}
              onClick={() => props.onChoose(item.messageId)}
            >
              <span data-rewind-label className="min-w-0 flex-1 truncate">
                {rewindItemLabel(item)}
              </span>
              {time ? (
                <span
                  className={cn(
                    "shrink-0 text-xs tabular-nums",
                    active ? "text-accent-foreground/72" : "text-muted-foreground",
                  )}
                >
                  {time}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </DialogPanel>
  );
}
