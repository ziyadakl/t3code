import { MessageId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
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

const onChoose = vi.fn();
const onCancel = vi.fn();
const scrollIntoView = vi.fn<(this: Element, options?: ScrollIntoViewOptions) => void>();

const picker = (open = true) => (
  <RewindPicker open={open} items={items} onChoose={onChoose} onCancel={onCancel} />
);

// Fresh mocks for one test; the browser's scrollIntoView comes back when it ends.
function setup(): Disposable {
  onChoose.mockReset();
  onCancel.mockReset();
  scrollIntoView.mockReset();
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scrollIntoView;
  return {
    [Symbol.dispose]() {
      Element.prototype.scrollIntoView = original;
    },
  };
}

const options = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
const selectedLabel = () =>
  options()
    .find((option) => option.getAttribute("aria-selected") === "true")
    ?.querySelector("[data-rewind-label]")?.textContent;

async function key(name: string) {
  const target = document.activeElement ?? document.body;
  await act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
    );
  });
}

describe("RewindPicker", () => {
  it("lists every message oldest first, one line each, with the newest selected", async () => {
    using _mocks = setup();
    await using _screen = await render(picker(), { router: false });
    expect(
      options().map((option) => option.querySelector("[data-rewind-label]")?.textContent),
    ).toEqual(["Add a login page", "Now style it", "1 attachment"]);
    expect(selectedLabel()).toBe("1 attachment");
  });

  it("opens scrolled to the newest message, however long the thread", async () => {
    using _mocks = setup();
    await using _screen = await render(picker(), { router: false });
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(options()[2]);
  });

  it("takes focus, so the arrow keys work straight away, and Enter chooses", async () => {
    using _mocks = setup();
    await using _screen = await render(picker(), { router: false });
    // base-ui moves focus into the popup a frame after it opens.
    await vi.waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("listbox"));
    await key("ArrowUp");
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(options()[1]);
    await key("ArrowUp");
    expect(selectedLabel()).toBe("Add a login page");
    await key("ArrowUp");
    expect(selectedLabel()).toBe("Add a login page");
    await key("ArrowDown");
    await key("Enter");
    expect(onChoose).toHaveBeenCalledExactlyOnceWith("m2");
  });

  it("follows the pointer and chooses the clicked message", async () => {
    using _mocks = setup();
    await using _screen = await render(picker(), { router: false });
    const [first] = options();
    await act(() => {
      first!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
    expect(selectedLabel()).toBe("Add a login page");
    await act(() => first!.click());
    expect(onChoose).toHaveBeenCalledExactlyOnceWith("m1");
  });

  it("opens and closes in a browser whose scrollIntoView returns a promise", async () => {
    using _mocks = setup();
    // Current Chrome resolves scrollIntoView with a promise; an effect that
    // returned it crashed the page with "destroy is not a function".
    scrollIntoView.mockImplementation(() => Promise.resolve() as unknown as void);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await using screen = await render(picker(), { router: false });
    await screen.rerender(picker(false));
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("closes without choosing on Escape", async () => {
    using _mocks = setup();
    await using _screen = await render(picker(), { router: false });
    await key("Escape");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onChoose).not.toHaveBeenCalled();
  });
});
