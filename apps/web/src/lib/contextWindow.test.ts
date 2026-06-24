import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, ThreadId, TurnId } from "@t3tools/contracts";

import {
  deriveLatestContextWindowSnapshot,
  formatContextWindowTokens,
  nextHeldContextWindow,
} from "./contextWindow";

function makeActivity(id: string, kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
}

describe("contextWindow", () => {
  it("derives the latest valid context window snapshot", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 1000,
      }),
      makeActivity("activity-2", "tool.started", {}),
      makeActivity("activity-3", "context-window.updated", {
        usedTokens: 14_000,
        maxTokens: 258_000,
        compactsAutomatically: true,
      }),
    ]);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(14_000);
    expect(snapshot?.totalProcessedTokens).toBeNull();
    expect(snapshot?.maxTokens).toBe(258_000);
    expect(snapshot?.compactsAutomatically).toBe(true);
  });

  it("ignores malformed payloads", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {}),
    ]);

    expect(snapshot).toBeNull();
  });

  it("keeps valid zero-usage snapshots", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        maxTokens: 100_000,
      }),
    ]);

    expect(snapshot).toMatchObject({
      usedTokens: 0,
      maxTokens: 100_000,
      remainingTokens: 100_000,
      usedPercentage: 0,
      remainingPercentage: 100,
    });
  });

  it("formats compact token counts", () => {
    expect(formatContextWindowTokens(999)).toBe("999");
    expect(formatContextWindowTokens(1400)).toBe("1.4k");
    expect(formatContextWindowTokens(14_000)).toBe("14k");
    expect(formatContextWindowTokens(258_000)).toBe("258k");
  });

  it("includes total processed tokens when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 81_659,
        totalProcessedTokens: 748_126,
        maxTokens: 258_400,
        lastUsedTokens: 81_659,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(81_659);
    expect(snapshot?.totalProcessedTokens).toBe(748_126);
  });
});

describe("nextHeldContextWindow", () => {
  const threadA = ThreadId.make("thread-a");
  const threadB = ThreadId.make("thread-b");
  const held = deriveLatestContextWindowSnapshot([
    makeActivity("held", "context-window.updated", { usedTokens: 100, maxTokens: 1000 }),
  ]);
  const live = deriveLatestContextWindowSnapshot([
    makeActivity("live", "context-window.updated", { usedTokens: 500, maxTokens: 1000 }),
  ]);

  it("adopts the new thread's live snapshot on a thread switch even while running (the leak fix)", () => {
    expect(
      nextHeldContextWindow({
        previousThreadId: threadA,
        activeThreadId: threadB,
        held,
        live,
        phase: "running",
      }),
    ).toBe(live);
  });

  it("adopts the live snapshot on a thread switch when settled", () => {
    expect(
      nextHeldContextWindow({
        previousThreadId: threadA,
        activeThreadId: threadB,
        held,
        live,
        phase: "ready",
      }),
    ).toBe(live);
  });

  it("holds the last settled value while a turn runs on the same thread (anti-balloon)", () => {
    expect(
      nextHeldContextWindow({
        previousThreadId: threadA,
        activeThreadId: threadA,
        held,
        live,
        phase: "running",
      }),
    ).toBe(held);
  });

  it("adopts the live snapshot when settled on the same thread", () => {
    expect(
      nextHeldContextWindow({
        previousThreadId: threadA,
        activeThreadId: threadA,
        held,
        live,
        phase: "ready",
      }),
    ).toBe(live);
  });

  it("treats a switch from a null thread as a thread change", () => {
    expect(
      nextHeldContextWindow({
        previousThreadId: null,
        activeThreadId: threadA,
        held,
        live,
        phase: "running",
      }),
    ).toBe(live);
  });
});
