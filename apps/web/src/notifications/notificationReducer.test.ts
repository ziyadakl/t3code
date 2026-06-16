import type { AgentAwarenessPhase } from "@t3tools/shared/agentAwareness";
import { headlineForPhase } from "@t3tools/shared/agentAwareness";
import { describe, expect, it } from "vite-plus/test";

import {
  computeNotifications,
  type NotificationContext,
  type ThreadPhaseSnapshot,
} from "./notificationReducer";

const KEY = "env-1:thread-1";

function snapshot(
  overrides: Partial<ThreadPhaseSnapshot> & Pick<ThreadPhaseSnapshot, "phase">,
): ThreadPhaseSnapshot {
  return {
    key: KEY,
    title: "My thread",
    environmentId: "env-1",
    threadId: "thread-1",
    ...overrides,
  };
}

const unfocused: NotificationContext = { isFocused: false, activeKey: null };

describe("computeNotifications", () => {
  it("seeds silently when the key is not present in prev", () => {
    const prev = new Map<string, AgentAwarenessPhase | null>();

    const { next, toFire } = computeNotifications(
      prev,
      [snapshot({ phase: "completed" })],
      unfocused,
    );

    expect(toFire).toEqual([]);
    expect(next.get(KEY)).toBe("completed");
  });

  it("fires once when transitioning into a notify phase while unfocused", () => {
    const prev = new Map<string, AgentAwarenessPhase | null>([[KEY, "running"]]);

    const { next, toFire } = computeNotifications(
      prev,
      [snapshot({ phase: "completed" })],
      unfocused,
    );

    expect(toFire).toHaveLength(1);
    expect(toFire[0]).toEqual({
      key: KEY,
      phase: "completed",
      title: headlineForPhase("completed"),
      body: "My thread",
      environmentId: "env-1",
      threadId: "thread-1",
    });
    expect(next.get(KEY)).toBe("completed");
  });

  it("does not refire when the phase is unchanged", () => {
    const prev = new Map<string, AgentAwarenessPhase | null>([[KEY, "completed"]]);

    const { toFire } = computeNotifications(
      prev,
      [snapshot({ phase: "completed" })],
      unfocused,
    );

    expect(toFire).toEqual([]);
  });

  it("suppresses the notification when the active thread is focused", () => {
    const prev = new Map<string, AgentAwarenessPhase | null>([[KEY, "running"]]);

    const { toFire } = computeNotifications(prev, [snapshot({ phase: "completed" })], {
      isFocused: true,
      activeKey: KEY,
    });

    expect(toFire).toEqual([]);
  });

  it("fires when a different thread is focused", () => {
    const prev = new Map<string, AgentAwarenessPhase | null>([[KEY, "running"]]);

    const { toFire } = computeNotifications(prev, [snapshot({ phase: "completed" })], {
      isFocused: true,
      activeKey: "env-9:other",
    });

    expect(toFire).toHaveLength(1);
    expect(toFire[0]?.title).toBe(headlineForPhase("completed"));
  });

  it("fires when the tab is hidden even if it is the active key", () => {
    const prev = new Map<string, AgentAwarenessPhase | null>([[KEY, "running"]]);

    const { toFire } = computeNotifications(prev, [snapshot({ phase: "completed" })], {
      isFocused: false,
      activeKey: KEY,
    });

    expect(toFire).toHaveLength(1);
    expect(toFire[0]?.title).toBe(headlineForPhase("completed"));
  });

  it("fires for each notify phase transitioned into from running", () => {
    const notifyPhases: AgentAwarenessPhase[] = [
      "failed",
      "waiting_for_approval",
      "waiting_for_input",
    ];

    for (const phase of notifyPhases) {
      const prev = new Map<string, AgentAwarenessPhase | null>([[KEY, "running"]]);

      const { toFire } = computeNotifications(prev, [snapshot({ phase })], unfocused);

      expect(toFire).toHaveLength(1);
      expect(toFire[0]?.phase).toBe(phase);
      expect(toFire[0]?.title).toBe(headlineForPhase(phase));
    }
  });

  it("does not refire on a reconnect re-snapshot of an already-seeded phase", () => {
    const prev = new Map<string, AgentAwarenessPhase | null>([[KEY, "completed"]]);

    const { toFire } = computeNotifications(
      prev,
      [snapshot({ phase: "completed" })],
      unfocused,
    );

    expect(toFire).toEqual([]);
  });
});
