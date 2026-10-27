import { createElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import {
  INITIAL_ESCAPE_STATE,
  isEscapeOwnedElsewhere,
  resolveEscapePress,
  useEscapeToStopAndRewind,
  type EscapePressInput,
  type UseEscapeToStopAndRewindOptions,
} from "./escapeRewind";

const press = (overrides: Partial<EscapePressInput>): EscapePressInput => ({
  now: 0,
  running: false,
  blocked: false,
  canRewind: true,
  ...overrides,
});

/** Feeds presses in order and returns the action each one produced. */
function actionsFor(presses: ReadonlyArray<Partial<EscapePressInput>>) {
  let state = INITIAL_ESCAPE_STATE;
  return presses.map((overrides) => {
    const result = resolveEscapePress(state, press(overrides));
    state = result.nextState;
    return result.action;
  });
}

describe("resolveEscapePress", () => {
  it("opens the picker on a quick second press while idle", () => {
    expect(actionsFor([{ now: 1_000 }, { now: 1_300 }])).toEqual(["none", "open-picker"]);
  });

  it("stops a running turn on the first press, then opens the picker on a quick second", () => {
    expect(
      actionsFor([
        { now: 1_000, running: true },
        { now: 1_200, running: true },
      ]),
    ).toEqual(["stop", "open-picker"]);
  });

  it("never opens the picker on presses more than 500 ms apart", () => {
    expect(actionsFor([{ now: 1_000 }, { now: 1_501 }, { now: 2_002 }])).toEqual([
      "none",
      "none",
      "none",
    ]);
  });

  it("forgets a press once it is blocked, so a blocked press cannot pair up", () => {
    expect(
      actionsFor([{ now: 1_000 }, { now: 1_100, blocked: true }, { now: 1_200 }, { now: 1_300 }]),
    ).toEqual(["none", "none", "none", "open-picker"]);
  });

  it("does nothing on a blocked press, even while a turn runs", () => {
    expect(actionsFor([{ now: 1_000, running: true, blocked: true }])).toEqual(["none"]);
  });

  it("keeps stopping on quick presses when there is nothing to rewind", () => {
    expect(
      actionsFor([
        { now: 1_000, running: true, canRewind: false },
        { now: 1_200, running: true, canRewind: false },
      ]),
    ).toEqual(["stop", "stop"]);
  });

  it("starts a fresh pair after the picker opens, so a third quick press does not reopen it", () => {
    expect(actionsFor([{ now: 1_000 }, { now: 1_100 }, { now: 1_200 }])).toEqual([
      "none",
      "open-picker",
      "none",
    ]);
  });
});

function escapeOn(target: EventTarget, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

function mount(html: string): HTMLElement & Disposable {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  return Object.assign(host, { [Symbol.dispose]: () => host.remove() });
}

describe("isEscapeOwnedElsewhere", () => {
  it("leaves a plain Escape on the page to the rewind shortcut", () => {
    expect(isEscapeOwnedElsewhere(escapeOn(document.body))).toBe(false);
  });

  it("yields to a handler that already claimed the key", () => {
    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    event.preventDefault();
    expect(isEscapeOwnedElsewhere(event)).toBe(true);
  });

  it("yields to an IME composition in progress", () => {
    expect(isEscapeOwnedElsewhere(escapeOn(document.body, { isComposing: true }))).toBe(true);
  });

  it.each([
    ["dialog", `<div data-slot="dialog-popup" data-open></div>`],
    ["alert dialog", `<div data-slot="alert-dialog-popup" data-open></div>`],
    ["command palette", `<div data-slot="command-dialog-popup" data-open></div>`],
    ["menu", `<div data-slot="menu-popup" data-open></div>`],
    ["select", `<div data-slot="select-popup" data-open></div>`],
    ["popover", `<div data-slot="popover-popup" data-open></div>`],
    ["combobox", `<div data-slot="combobox-popup" data-open></div>`],
    ["closing dialog", `<div data-slot="dialog-popup" data-ending-style></div>`],
    ["mobile sidebar", `<div data-slot="sidebar" data-mobile="true" data-open></div>`],
    ["bare modal", `<div role="dialog" aria-modal="true"></div>`],
  ])("yields while the %s is open", (_name, html) => {
    using _host = mount(html);
    expect(isEscapeOwnedElsewhere(escapeOn(document.body))).toBe(true);
  });

  it("ignores layers that stay mounted while closed, such as the sidebar's search results", () => {
    using _host = mount(`
      <div data-slot="menu-popup" data-closed></div>
      <ul role="listbox" aria-label="Thread search results"><li role="option">x</li></ul>
    `);
    expect(isEscapeOwnedElsewhere(escapeOn(document.body))).toBe(false);
  });

  it("yields to a focused terminal, where Escape belongs to the shell", () => {
    using host = mount(`<div data-terminal-owner="drawer"><textarea></textarea></div>`);
    const input = host.querySelector("textarea")!;
    input.focus();
    expect(isEscapeOwnedElsewhere(escapeOn(input))).toBe(true);
  });
});

describe("useEscapeToStopAndRewind", () => {
  const onStop = vi.fn();
  const onOpenPicker = vi.fn();

  function Harness(props: UseEscapeToStopAndRewindOptions) {
    useEscapeToStopAndRewind(props);
    return null;
  }

  // Fresh mocks and a controllable Date.now for one test; both are undone when it ends.
  function setup() {
    onStop.mockReset();
    onOpenPicker.mockReset();
    let now = 0;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    return {
      set: (value: number) => {
        now = value;
      },
      [Symbol.dispose]: () => dateNow.mockRestore(),
    };
  }

  const harness = (overrides: Partial<UseEscapeToStopAndRewindOptions> = {}) =>
    createElement(Harness, {
      enabled: true,
      running: false,
      canRewind: true,
      onStop,
      onOpenPicker,
      ...overrides,
    });

  it("stops a running turn on Escape and opens the picker on a quick second Escape", async () => {
    using clock = setup();
    await using _screen = await render(harness({ running: true }), { router: false });
    clock.set(10_000);
    const first = escapeOn(document.body);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onOpenPicker).not.toHaveBeenCalled();
    expect(first.defaultPrevented).toBe(true);

    clock.set(10_250);
    escapeOn(document.body);
    expect(onOpenPicker).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("leaves a lone idle Escape untouched, so nothing else loses it", async () => {
    using clock = setup();
    await using _screen = await render(harness(), { router: false });
    clock.set(10_000);
    const event = escapeOn(document.body);
    expect(event.defaultPrevented).toBe(false);
    expect(onStop).not.toHaveBeenCalled();
    expect(onOpenPicker).not.toHaveBeenCalled();
  });

  it("ignores a held-down Escape's auto-repeat", async () => {
    using clock = setup();
    await using _screen = await render(harness(), { router: false });
    clock.set(10_000);
    escapeOn(document.body);
    clock.set(10_030);
    escapeOn(document.body, { repeat: true });
    expect(onOpenPicker).not.toHaveBeenCalled();
  });

  it("lets the composer close its own menu first: an Escape it stops never counts", async () => {
    using clock = setup();
    await using _screen = await render(harness({ running: true }), { router: false });
    using editor = mount("");
    editor.addEventListener("keydown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    clock.set(10_000);
    escapeOn(editor);
    clock.set(10_200);
    escapeOn(editor);
    expect(onStop).not.toHaveBeenCalled();
    expect(onOpenPicker).not.toHaveBeenCalled();
  });

  it("does nothing while disabled", async () => {
    using clock = setup();
    await using _screen = await render(harness({ enabled: false, running: true }), {
      router: false,
    });
    clock.set(10_000);
    escapeOn(document.body);
    clock.set(10_100);
    escapeOn(document.body);
    expect(onStop).not.toHaveBeenCalled();
    expect(onOpenPicker).not.toHaveBeenCalled();
  });
});
