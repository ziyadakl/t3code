import "../../index.css";

import { EventId, type OrchestrationThreadActivity, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import {
  type ContextWindowSnapshot,
  deriveLatestContextWindowSnapshot,
} from "../../lib/contextWindow";
import type { SessionPhase } from "../../types";
import { useHeldContextWindow } from "./useHeldContextWindow";

const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");

function snapshot(usedTokens: number): ContextWindowSnapshot {
  const activity: OrchestrationThreadActivity = {
    id: EventId.make(`cw-${usedTokens}`),
    tone: "info",
    kind: "context-window.updated",
    summary: "context-window.updated",
    payload: { usedTokens, maxTokens: 1_000_000 },
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-06-24T00:00:00.000Z",
  };
  const derived = deriveLatestContextWindowSnapshot([activity]);
  if (!derived) {
    throw new Error("failed to build context window snapshot fixture");
  }
  return derived;
}

function Harness(props: {
  threadId: ThreadId | null;
  live: ContextWindowSnapshot | null;
  phase: SessionPhase;
}) {
  const held = useHeldContextWindow(props.threadId, props.live, props.phase);
  return <div data-testid="meter">{held ? `USED:${held.usedTokens}` : "USED:none"}</div>;
}

describe("useHeldContextWindow", () => {
  // The reported symptom: every open thread showed the same context value. This drives the
  // real component through a thread switch and asserts the *rendered* value, so it goes red
  // on the leak (the meter keeps showing the previously-viewed thread's number).
  it("shows the newly-opened thread's value even when that thread is mid-run", async () => {
    // Viewing thread A, turn settled → meter shows A's value.
    const screen = await render(<Harness threadId={threadA} live={snapshot(100)} phase="ready" />);
    try {
      await expect.element(page.getByText("USED:100")).toBeVisible();

      // Switch to thread B while B is mid-run. Before the fix, the held value only
      // refreshed when the phase was not "running", so it kept showing A's 100.
      await screen.rerender(<Harness threadId={threadB} live={snapshot(500)} phase="running" />);
      await expect.element(page.getByText("USED:500")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  // Guards the original behavior the fix must preserve: within one thread, a running turn
  // streams accumulated totals that balloon toward the cap — the meter must hold the last
  // settled value rather than follow the balloon.
  it("holds the last settled value while a turn runs on the same thread", async () => {
    const screen = await render(<Harness threadId={threadA} live={snapshot(100)} phase="ready" />);
    try {
      await expect.element(page.getByText("USED:100")).toBeVisible();

      // Same thread, now running with a ballooned live reading — must stay at 100.
      await screen.rerender(
        <Harness threadId={threadA} live={snapshot(950_000)} phase="running" />,
      );
      await expect.element(page.getByText("USED:100")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
