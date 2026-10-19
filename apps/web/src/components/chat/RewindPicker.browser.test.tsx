import { MessageId } from "@t3tools/contracts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { RewindPicker } from "./RewindPicker";
import type { RewindPickerItem } from "./RewindPicker.logic";

const items: ReadonlyArray<RewindPickerItem> = [
  {
    messageId: MessageId.make("m1"),
    text: "Add a login page",
    createdAt: "2026-10-12T09:00:00Z",
    attachmentCount: 0,
  },
  {
    messageId: MessageId.make("m2"),
    text: "  Now style it",
    createdAt: "2026-10-12T09:10:00Z",
    attachmentCount: 0,
  },
  {
    messageId: MessageId.make("m3"),
    text: "",
    createdAt: "2026-10-12T09:20:00Z",
    attachmentCount: 1,
  },
];

let root: Root;
let container: HTMLDivElement;
const onChoose = vi.fn();
const onCancel = vi.fn();

function render(open = true) {
  act(() => {
    root.render(createElement(RewindPicker, { open, items, onChoose, onCancel }));
  });
}

const options = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
const selectedLabel = () =>
  options()
    .find((option) => option.getAttribute("aria-selected") === "true")
    ?.querySelector("[data-rewind-label]")?.textContent;

function key(name: string) {
  const target = document.activeElement ?? document.body;
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
    );
  });
}

const scrollIntoView = vi.fn<(this: Element, options?: ScrollIntoViewOptions) => void>();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom does no layout, so it has no scrollIntoView; record the calls instead.
  Element.prototype.scrollIntoView = scrollIntoView;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  onChoose.mockReset();
  onCancel.mockReset();
  scrollIntoView.mockReset();
  vi.unstubAllGlobals();
});

describe("RewindPicker", () => {
  it("lists every message oldest first, one line each, with the newest selected", () => {
    render();
    expect(
      options().map((option) => option.querySelector("[data-rewind-label]")?.textContent),
    ).toEqual(["Add a login page", "Now style it", "1 attachment"]);
    expect(selectedLabel()).toBe("1 attachment");
  });

  it("opens scrolled to the newest message, however long the thread", () => {
    render();
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(options()[2]);
  });

  it("takes focus, so the arrow keys work straight away, and Enter chooses", async () => {
    render();
    // base-ui moves focus into the popup a frame after it opens.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(document.activeElement?.getAttribute("role")).toBe("listbox");
    key("ArrowUp");
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(options()[1]);
    key("ArrowUp");
    expect(selectedLabel()).toBe("Add a login page");
    key("ArrowUp");
    expect(selectedLabel()).toBe("Add a login page");
    key("ArrowDown");
    key("Enter");
    expect(onChoose).toHaveBeenCalledExactlyOnceWith("m2");
  });

  it("follows the pointer and chooses the clicked message", () => {
    render();
    const [first] = options();
    act(() => {
      first!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
    expect(selectedLabel()).toBe("Add a login page");
    act(() => first!.click());
    expect(onChoose).toHaveBeenCalledExactlyOnceWith("m1");
  });

  it("opens and closes in a browser whose scrollIntoView returns a promise", () => {
    // Current Chrome resolves scrollIntoView with a promise; an effect that
    // returned it crashed the page with "destroy is not a function".
    scrollIntoView.mockImplementation(() => Promise.resolve() as unknown as void);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    render();
    render(false);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("closes without choosing on Escape", () => {
    render();
    key("Escape");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onChoose).not.toHaveBeenCalled();
  });
});
