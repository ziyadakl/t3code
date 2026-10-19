import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

function mount(html: string) {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

describe("isEscapeOwnedElsewhere", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

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
    mount(html);
    expect(isEscapeOwnedElsewhere(escapeOn(document.body))).toBe(true);
  });

  it("ignores layers that stay mounted while closed, such as the sidebar's search results", () => {
    mount(`
      <div data-slot="menu-popup" data-closed></div>
      <ul role="listbox" aria-label="Thread search results"><li role="option">x</li></ul>
    `);
    expect(isEscapeOwnedElsewhere(escapeOn(document.body))).toBe(false);
  });

  it("yields to a focused terminal, where Escape belongs to the shell", () => {
    const host = mount(`<div data-terminal-owner="drawer"><textarea></textarea></div>`);
    const input = host.querySelector("textarea")!;
    input.focus();
    expect(isEscapeOwnedElsewhere(escapeOn(input))).toBe(true);
  });
});

describe("useEscapeToStopAndRewind", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onStop = vi.fn();
  const onOpenPicker = vi.fn();

  function Harness(props: UseEscapeToStopAndRewindOptions) {
    useEscapeToStopAndRewind(props);
    return null;
  }

  function render(overrides: Partial<UseEscapeToStopAndRewindOptions> = {}) {
    act(() => {
      root.render(
        createElement(Harness, {
          enabled: true,
          running: false,
          canRewind: true,
          onStop,
          onOpenPicker,
          ...overrides,
        }),
      );
    });
  }

  function escapeAt(
    now: number,
    target: EventTarget = document.body,
    init: KeyboardEventInit = {},
  ) {
    vi.setSystemTime(now);
    return escapeOn(target, init);
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    onStop.mockReset();
    onOpenPicker.mockReset();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("stops a running turn on Escape and opens the picker on a quick second Escape", () => {
    render({ running: true });
    const first = escapeAt(10_000);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onOpenPicker).not.toHaveBeenCalled();
    expect(first.defaultPrevented).toBe(true);

    escapeAt(10_250);
    expect(onOpenPicker).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("leaves a lone idle Escape untouched, so nothing else loses it", () => {
    render();
    const event = escapeAt(10_000);
    expect(event.defaultPrevented).toBe(false);
    expect(onStop).not.toHaveBeenCalled();
    expect(onOpenPicker).not.toHaveBeenCalled();
  });

  it("ignores a held-down Escape's auto-repeat", () => {
    render();
    escapeAt(10_000);
    escapeAt(10_030, document.body, { repeat: true });
    expect(onOpenPicker).not.toHaveBeenCalled();
  });

  it("lets the composer close its own menu first: an Escape it stops never counts", () => {
    render({ running: true });
    const editor = document.createElement("div");
    document.body.append(editor);
    editor.addEventListener("keydown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    escapeAt(10_000, editor);
    escapeAt(10_200, editor);
    expect(onStop).not.toHaveBeenCalled();
    expect(onOpenPicker).not.toHaveBeenCalled();
  });

  it("does nothing while disabled", () => {
    render({ enabled: false, running: true });
    escapeAt(10_000);
    escapeAt(10_100);
    expect(onStop).not.toHaveBeenCalled();
    expect(onOpenPicker).not.toHaveBeenCalled();
  });
});
