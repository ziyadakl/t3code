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

describe("buildRunningSubagentTree", () => {
  it("returns one row per running top-level subagent with its type", () => {
    const rows = buildRunningSubagentTree([
      collab({ kind: "tool.started", toolUseId: "a", subagentType: "Explore" }),
      collab({ kind: "tool.started", toolUseId: "b", subagentType: "Plan" }),
    ]);
    expect(rows).toEqual([
      { subagentType: "Explore", descendantCount: 0 },
      { subagentType: "Plan", descendantCount: 0 },
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
    expect(rows).toEqual([{ subagentType: "orchestrator", descendantCount: 4 }]);
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
    expect(rows).toEqual([{ subagentType: "orchestrator", descendantCount: 1 }]);
  });

  it("counts a 5-deep chain and the deepest node shows +0", () => {
    const rows = buildRunningSubagentTree([
      collab({ kind: "tool.started", toolUseId: "d1", subagentType: "L1" }),
      collab({ kind: "tool.started", toolUseId: "d2", parentToolUseId: "d1", subagentType: "L2" }),
      collab({ kind: "tool.started", toolUseId: "d3", parentToolUseId: "d2", subagentType: "L3" }),
      collab({ kind: "tool.started", toolUseId: "d4", parentToolUseId: "d3", subagentType: "L4" }),
      collab({ kind: "tool.started", toolUseId: "d5", parentToolUseId: "d4", subagentType: "L5" }),
    ]);
    // Only d1 is top-level; every other node has an in-map parent.
    expect(rows).toEqual([{ subagentType: "L1", descendantCount: 4 }]);
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
    expect(rows).toEqual([{ subagentType: "orphan", descendantCount: 0 }]);
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
    expect(rows).toEqual([{ subagentType: "Explore", descendantCount: 0 }]);
  });

  it("ignores non-collab activities", () => {
    const rows = buildRunningSubagentTree([
      other("tool.started"),
      collab({ kind: "tool.started", toolUseId: "a", subagentType: "Explore" }),
    ]);
    expect(rows).toEqual([{ subagentType: "Explore", descendantCount: 0 }]);
  });

  it("returns an empty array for no activities", () => {
    expect(buildRunningSubagentTree([])).toEqual([]);
  });
});
