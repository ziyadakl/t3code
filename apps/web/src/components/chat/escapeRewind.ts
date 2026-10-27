import { useEffect, useEffectEvent, useRef } from "react";

import { FLOATING_LAYER_SELECTOR } from "~/lib/floatingLayer";
import { isTerminalFocused } from "~/lib/terminalFocus";

/** How close two Escape presses must be to count as a double press. */
const DOUBLE_ESCAPE_WINDOW_MS = 500;

export interface EscapeState {
  /** When the last unblocked press landed, or null when none is remembered. */
  readonly lastPressAt: number | null;
}

export const INITIAL_ESCAPE_STATE: EscapeState = { lastPressAt: null };

export interface EscapePressInput {
  readonly now: number;
  readonly running: boolean;
  readonly blocked: boolean;
  readonly canRewind: boolean;
}

export type EscapeAction = "stop" | "open-picker" | "none";

export function resolveEscapePress(
  state: EscapeState,
  input: EscapePressInput,
): { action: EscapeAction; nextState: EscapeState } {
  if (input.blocked) return { action: "none", nextState: INITIAL_ESCAPE_STATE };
  if (
    input.canRewind &&
    state.lastPressAt !== null &&
    input.now - state.lastPressAt <= DOUBLE_ESCAPE_WINDOW_MS
  ) {
    return { action: "open-picker", nextState: INITIAL_ESCAPE_STATE };
  }
  return { action: input.running ? "stop" : "none", nextState: { lastPressAt: input.now } };
}

/**
 * Whether this Escape press belongs to something other than stop/rewind:
 * a handler that already claimed it, an IME composition, or an open
 * dialog, menu or popover that Escape should close instead, or a focused
 * terminal, where the shell (vim, less, a REPL) reads Escape itself.
 */
export function isEscapeOwnedElsewhere(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || isTerminalFocused()) return true;
  return document.querySelector(FLOATING_LAYER_SELECTOR) !== null;
}

export interface UseEscapeToStopAndRewindOptions {
  /** Off while there is no active thread, so Escape keeps its default meaning. */
  readonly enabled: boolean;
  /** A turn is running and can be interrupted. */
  readonly running: boolean;
  /** The thread has at least one user message the picker could rewind to. */
  readonly canRewind: boolean;
  readonly onStop: () => void;
  readonly onOpenPicker: () => void;
}

/**
 * Escape stops a running turn; Escape twice within 500 ms opens the rewind picker.
 * Listens in the bubble phase so the composer's menus and base-ui dialogs, which close on
 * Escape first, keep it; a capture listener would steal theirs.
 */
export function useEscapeToStopAndRewind(options: UseEscapeToStopAndRewindOptions): void {
  const stateRef = useRef(INITIAL_ESCAPE_STATE);
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.repeat) return;
    const { action, nextState } = resolveEscapePress(stateRef.current, {
      now: Date.now(),
      running: options.running,
      canRewind: options.canRewind,
      blocked: isEscapeOwnedElsewhere(event),
    });
    stateRef.current = nextState;
    if (action === "none") return;
    event.preventDefault();
    if (action === "stop") options.onStop();
    else options.onOpenPicker();
  });

  // oxlint-disable-next-line t3code/react-effect-budget -- subscribes a window keydown listener (an external system) while enabled
  useEffect(() => {
    if (!options.enabled) return;
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [options.enabled]);
}
