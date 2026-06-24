import { useEffect, useRef, useState } from "react";

import type { ThreadId } from "@t3tools/contracts";

import { type ContextWindowSnapshot, nextHeldContextWindow } from "../../lib/contextWindow";
import type { SessionPhase } from "../../types";

/**
 * Holds the context-window snapshot the composer meter displays.
 *
 * While a turn is running the value is held steady: mid-turn the provider streams
 * accumulated token totals that balloon toward the window cap and misread ~100% (see
 * ClaudeAdapter completeTurn), so only the settled end-of-turn reading is window-accurate.
 *
 * Crucially, that hold is PER-THREAD. On a thread switch the new thread's live snapshot is
 * adopted immediately — even mid-run — so a thread opened while a turn is running can never
 * keep showing the previously-viewed thread's value (which made the meter read the same
 * number for every open thread). See {@link nextHeldContextWindow}.
 */
export function useHeldContextWindow(
  activeThreadId: ThreadId | null,
  liveContextWindow: ContextWindowSnapshot | null,
  phase: SessionPhase,
): ContextWindowSnapshot | null {
  const [held, setHeld] = useState(liveContextWindow);
  const previousThreadIdRef = useRef(activeThreadId);
  useEffect(() => {
    const previousThreadId = previousThreadIdRef.current;
    previousThreadIdRef.current = activeThreadId;
    setHeld((current) =>
      nextHeldContextWindow({
        previousThreadId,
        activeThreadId,
        held: current,
        live: liveContextWindow,
        phase,
      }),
    );
  }, [activeThreadId, phase, liveContextWindow]);
  return held;
}
