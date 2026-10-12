import type { MessageId } from "@t3tools/contracts";
import type { TimelineEntry } from "../../session-logic";

/** Messages are listed oldest first, so the newest is last and starts selected. */
export function initialRewindIndex(count: number): number {
  return count - 1;
}

/**
 * The selection after a navigation key. It stops at either end rather than
 * wrapping: one press too many on the newest message should not jump to the
 * oldest, which would rewind the whole conversation.
 */
export function moveRewindSelection(index: number, key: string, count: number): number {
  const last = count - 1;
  switch (key) {
    case "ArrowUp":
      return Math.max(0, index - 1);
    case "ArrowDown":
      return Math.min(last, index + 1);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return index;
  }
}

/** One row of the rewind picker: a user message the thread can go back to. */
export interface RewindPickerItem {
  readonly messageId: MessageId;
  readonly text: string;
  /** ISO timestamp, shown as relative time. */
  readonly createdAt: string;
  /** Images and files sent with the message; names a text-less message. */
  readonly attachmentCount?: number;
}

/** A single-line label: the first non-blank line, or what the message carried. */
export function rewindItemLabel(item: Pick<RewindPickerItem, "text" | "attachmentCount">): string {
  const firstLine = item.text.trimStart().split("\n", 1)[0]?.trimEnd() ?? "";
  if (firstLine.length > 0) return firstLine;
  const attachments = item.attachmentCount ?? 0;
  if (attachments > 0) return `${attachments} ${attachments === 1 ? "attachment" : "attachments"}`;
  return "Empty message";
}

/** The picker rows: every message in `targets` (the rewind arrows' messages), oldest first. */
export function rewindPickerItems(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  targets: ReadonlyMap<MessageId, number>,
): RewindPickerItem[] {
  return timelineEntries.flatMap((entry) =>
    entry.kind === "message" && targets.has(entry.message.id)
      ? [
          {
            messageId: entry.message.id,
            text: entry.message.text,
            createdAt: entry.message.createdAt,
            attachmentCount: entry.message.attachments?.length ?? 0,
          },
        ]
      : [],
  );
}
