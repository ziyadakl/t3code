import { describe, expect, it } from "vite-plus/test";

import { MessageId } from "@t3tools/contracts";
import {
  initialRewindIndex,
  moveRewindSelection,
  rewindItemLabel,
  rewindPickerItems,
} from "./RewindPicker.logic";

describe("initialRewindIndex", () => {
  it("selects the newest message, which sits last", () => {
    expect(initialRewindIndex(4)).toBe(3);
  });
});

describe("moveRewindSelection", () => {
  it("moves up to older messages and down to newer ones", () => {
    expect(moveRewindSelection(3, "ArrowUp", 4)).toBe(2);
    expect(moveRewindSelection(1, "ArrowDown", 4)).toBe(2);
  });

  it("stops at either end instead of wrapping", () => {
    expect(moveRewindSelection(0, "ArrowUp", 4)).toBe(0);
    expect(moveRewindSelection(3, "ArrowDown", 4)).toBe(3);
  });

  it("jumps to the oldest on Home and the newest on End", () => {
    expect(moveRewindSelection(2, "Home", 4)).toBe(0);
    expect(moveRewindSelection(0, "End", 4)).toBe(3);
  });

  it("leaves the selection alone for other keys", () => {
    expect(moveRewindSelection(2, "a", 4)).toBe(2);
  });
});

describe("rewindItemLabel", () => {
  it("shows the first line of the message, without its leading blank space", () => {
    expect(rewindItemLabel({ text: "\n\n   Fix the login bug\nIt fails on Safari." })).toBe(
      "Fix the login bug",
    );
  });

  it("names the attachments when a message has no text", () => {
    expect(rewindItemLabel({ text: "  \n", attachmentCount: 1 })).toBe("1 attachment");
    expect(rewindItemLabel({ text: "", attachmentCount: 3 })).toBe("3 attachments");
  });

  it("says so when a message is empty", () => {
    expect(rewindItemLabel({ text: " " })).toBe("Empty message");
  });
});

describe("rewindPickerItems", () => {
  const entry = (id: string, role: "user" | "assistant", extra: object = {}) => ({
    id: MessageId.make(id),
    kind: "message" as const,
    createdAt: `2026-06-20T00:00:0${id.length % 10}.000Z`,
    message: {
      id: MessageId.make(id),
      role,
      text: `${id} text`,
      runId: null,
      streaming: false,
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
      ...extra,
    },
  });

  it("lists only the messages the thread can rewind to, oldest first", () => {
    const items = rewindPickerItems(
      [
        entry("first", "user"),
        entry("reply", "assistant"),
        entry("steer", "user"),
        entry("second", "user", {
          attachments: [
            { type: "image", id: "a", name: "a.png", mimeType: "image/png", sizeBytes: 1 },
          ],
        }),
      ],
      new Map([
        [MessageId.make("first"), 0],
        [MessageId.make("second"), 1],
      ]),
    );
    expect(items).toEqual([
      {
        messageId: "first",
        text: "first text",
        createdAt: "2026-06-20T00:00:00.000Z",
        attachmentCount: 0,
      },
      {
        messageId: "second",
        text: "second text",
        createdAt: "2026-06-20T00:00:00.000Z",
        attachmentCount: 1,
      },
    ]);
  });
});
