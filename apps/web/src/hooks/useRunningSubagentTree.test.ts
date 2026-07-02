import { describe, expect, it } from "vite-plus/test";

import { buildRunningSubagentTree } from "./useRunningSubagentTree";
import type { Thread } from "../types";

type Activity = Thread["activities"][number];

/**
 * Build a `collab_agent_tool_call` lifecycle activity carrying the nested-subagent
 * seam fields (toolUseId / parentToolUseId / subagentType) the server now emits.
 */
function collab(input: {
  kind: "tool.started" | "tool.completed" | "tool.updated";
  toolUseId: string;
  parentToolUseId?: string;
  subagentType?: string;
  id?: string;
}): Activity {
  return {
    id: input.id ?? `${input.kind}-${input.toolUseId}-${Math.random()}`,
    tone: "tool",
    kind: input.kind,
    summary: "Task",
    payload: {
      itemType: "collab_agent_tool_call",
      toolUseId: input.toolUseId,
      ...(input.parentToolUseId === undefined ? {} : { parentToolUseId: input.parentToolUseId }),
      ...(input.subagentType === undefined ? {} : { subagentType: input.subagentType }),
    },
    turnId: null,
    createdAt: "2026-07-01T00:00:00.000Z",
  } as unknown as Activity;
}

function other(kind: string, id = `other-${Math.random()}`): Activity {
  return {
    id,
    tone: "tool",
    kind,
    summary: "Cmd",
    payload: { itemType: "command_execution" },
    turnId: null,
    createdAt: "2026-07-01T00:00:00.000Z",
  } as unknown as Activity;
}

/** Total running subagents a tree represents: one per row plus its running descendants. */
function totalRunning(rows: ReturnType<typeof buildRunningSubagentTree>): number {
  return rows.reduce((sum, row) => sum + 1 + row.descendantCount, 0);
}

describe("buildRunningSubagentTree", () => {
  it("returns one row per running top-level subagent with its type", () => {
    const rows = buildRunningSubagentTree([
      collab({ kind: "tool.started", toolUseId: "a", subagentType: "Explore" }),
      collab({ kind: "tool.started", toolUseId: "b", subagentType: "Plan" }),
    ]);
    expect(rows).toEqual([
      { toolUseId: "a", subagentType: "Explore", descendantCount: 0 },
      { toolUseId: "b", subagentType: "Plan", descendantCount: 0 },
    ]);
  });

  it("counts multi-level running descendants (parent + 2 children each with 1 child -> +4)", () => {
    const rows = buildRunningSubagentTree([
      collab({ kind: "tool.started", toolUseId: "root", subagentType: "orchestrator" }),
      collab({
        kind: "tool.started",
        toolUseId: "c1",
        parentToolUseId: "root",
        subagentType: "worker",
      }),
      collab({
        kind: "tool.started",
        toolUseId: "c2",
        parentToolUseId: "root",
        subagentType: "worker",
      }),
      collab({
        kind: "tool.started",
        toolUseId: "g1",
        parentToolUseId: "c1",
        subagentType: "leaf",
      }),
      collab({
        kind: "tool.started",
        toolUseId: "g2",
        parentToolUseId: "c2",
        subagentType: "leaf",
      }),
    ]);
    expect(rows).toEqual([{ toolUseId: "root", subagentType: "orchestrator", descendantCount: 4 }]);
  });

  it("decrements the descendant count when a descendant completes", () => {
    const rows = buildRunningSubagentTree([
      collab({ kind: "tool.started", toolUseId: "root", subagentType: "orchestrator" }),
      collab({
        kind: "tool.started",
        toolUseId: "c1",
        parentToolUseId: "root",
        subagentType: "worker",
      }),
      collab({
        kind: "tool.started",
        toolUseId: "c2",
        parentToolUseId: "root",
        subagentType: "worker",
      }),
      collab({ kind: "tool.completed", toolUseId: "c2" }),
    ]);
    expect(rows).toEqual([{ toolUseId: "root", subagentType: "orchestrator", descendantCount: 1 }]);
  });

  it("counts a 5-deep chain and the deepest node shows +0", () => {
    const rows = buildRunningSubagentTree([
      collab({ kind: "tool.started", toolUseId: "d1", subagentType: "L1" }),
      collab({ kind: "tool.started", toolUseId: "d2", parentToolUseId: "d1", subagentType: "L2" }),
      collab({ kind: "tool.started", toolUseId: "d3", parentToolUseId: "d2", subagentType: "L3" }),
      collab({ kind: "tool.started", toolUseId: "d4", parentToolUseId: "d3", subagentType: "L4" }),
      collab({ kind: "tool.started", toolUseId: "d5", parentToolUseId: "d4", subagentType: "L5" }),
    ]);
    // Only d1 is top-level; every other node has an in-map running parent.
    expect(rows).toEqual([{ toolUseId: "d1", subagentType: "L1", descendantCount: 4 }]);
  });

  it("treats an orphan-parent node (parent not in map) as top-level", () => {
    const rows = buildRunningSubagentTree([
      collab({
        kind: "tool.started",
        toolUseId: "x",
        parentToolUseId: "ghost",
        subagentType: "orphan",
      }),
    ]);
    expect(rows).toEqual([{ toolUseId: "x", subagentType: "orphan", descendantCount: 0 }]);
  });

  it("surfaces a still-running child of an already-completed parent as its own row (F1)", () => {
    // Parent A has already flipped running=false (started then completed) but its nested
    // child B is still running. B's nearest running ancestor is absent, so it must surface
    // as a top-level row instead of being dropped from the count entirely.
    const rows = buildRunningSubagentTree([
      collab({ kind: "tool.started", toolUseId: "a", subagentType: "parent" }),
      collab({ kind: "tool.completed", toolUseId: "a" }),
      collab({ kind: "tool.started", toolUseId: "b", parentToolUseId: "a", subagentType: "child" }),
    ]);
    expect(rows).toEqual([{ toolUseId: "b", subagentType: "child", descendantCount: 0 }]);
    // The still-running B is accounted for in the total.
    expect(totalRunning(rows)).toBe(1);
  });

  it("keeps a deeper running node under its running ancestor across a completed middle node", () => {
    // A (running) -> B (completed) -> C (running). B is not a row (running ancestor A);
    // C is not a row (running ancestor A across the gap); C counts as A's descendant.
    const rows = buildRunningSubagentTree([
      collab({ kind: "tool.started", toolUseId: "a", subagentType: "top" }),
      collab({ kind: "tool.started", toolUseId: "b", parentToolUseId: "a", subagentType: "mid" }),
      collab({ kind: "tool.completed", toolUseId: "b" }),
      collab({ kind: "tool.started", toolUseId: "c", parentToolUseId: "b", subagentType: "leaf" }),
    ]);
    expect(rows).toEqual([{ toolUseId: "a", subagentType: "top", descendantCount: 1 }]);
    expect(totalRunning(rows)).toBe(2);
  });

  it("does not count a self-parented running node as its own descendant (F2 cycle guard)", () => {
    const rows = buildRunningSubagentTree([
      collab({ kind: "tool.started", toolUseId: "s", parentToolUseId: "s", subagentType: "loop" }),
    ]);
    // Self-parent breaks the running-ancestor walk, so it is a row; the descendant count
    // must NOT count the node itself (the pre-fix increment sat outside the `seen` guard).
    expect(rows).toEqual([{ toolUseId: "s", subagentType: "loop", descendantCount: 0 }]);
  });

  it("does not overcount or hang on a two-node parent cycle (F2)", () => {
    const rows = buildRunningSubagentTree([
      collab({ kind: "tool.started", toolUseId: "a", parentToolUseId: "b", subagentType: "x" }),
      collab({ kind: "tool.started", toolUseId: "b", parentToolUseId: "a", subagentType: "y" }),
    ]);
    // Each node sees a running ancestor (the other), so neither is promoted to a row.
    // Crucially the fold terminates and nothing is double-counted.
    expect(rows).toEqual([]);
  });

  it("excludes a top-level node once it has completed", () => {
    const rows = buildRunningSubagentTree([
      collab({ kind: "tool.started", toolUseId: "a", subagentType: "Explore" }),
      collab({ kind: "tool.completed", toolUseId: "a" }),
    ]);
    expect(rows).toEqual([]);
  });

  it("backfills subagentType from a later activity for the same toolUseId", () => {
    const rows = buildRunningSubagentTree([
      collab({ kind: "tool.started", toolUseId: "a" }),
      collab({ kind: "tool.updated", toolUseId: "a", subagentType: "Explore" }),
    ]);
    expect(rows).toEqual([{ toolUseId: "a", subagentType: "Explore", descendantCount: 0 }]);
  });

  it('falls back to "agent" while a top-level node is running without a known type', () => {
    // The server streams `content_block_start` (item.started) with empty input, so the
    // real subagent_type only lands on a later `item.updated`. Until that update carries
    // the type, the running top-level row must show the generic fallback. This is the
    // bug the server-side fix addresses: the update now surfaces subagentType so the row
    // upgrades from "agent" to the real type mid-run (see the backfill test above).
    const rows = buildRunningSubagentTree([collab({ kind: "tool.started", toolUseId: "a" })]);
    expect(rows).toEqual([{ toolUseId: "a", subagentType: "agent", descendantCount: 0 }]);
  });

  it("ignores non-collab activities", () => {
    const rows = buildRunningSubagentTree([
      other("tool.started"),
      collab({ kind: "tool.started", toolUseId: "a", subagentType: "Explore" }),
    ]);
    expect(rows).toEqual([{ toolUseId: "a", subagentType: "Explore", descendantCount: 0 }]);
  });

  it("returns an empty array for no activities", () => {
    expect(buildRunningSubagentTree([])).toEqual([]);
  });
});
