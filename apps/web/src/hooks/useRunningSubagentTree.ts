import { useMemo } from "react";

import type { ThreadId } from "@t3tools/contracts";

import { useStore } from "../store";
import { createThreadSelectorAcrossEnvironments } from "../storeSelectors";
import type { Thread } from "../types";

/**
 * A subagent launch surfaces as a `collab_agent_tool_call` tool-lifecycle activity:
 * a `tool.started` when it spins up and a `tool.completed` when it finishes (see
 * apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts and projector.ts).
 * The lifecycle payload now also carries `toolUseId` (this call's id), `parentToolUseId`
 * (the parent Agent call for a nested subagent; absent for top-level), and `subagentType`
 * (which may only appear on the started OR a later updated/completed activity), so we can
 * reconstruct the live subagent tree instead of a flat count.
 */
const COLLAB_AGENT_ITEM_TYPE = "collab_agent_tool_call";

/** One running top-level subagent row: its type plus how many live descendants it has. */
export interface RunningSubagentRow {
  subagentType: string;
  descendantCount: number;
}

interface SubagentNode {
  toolUseId: string;
  parentToolUseId: string | undefined;
  subagentType: string | undefined;
  running: boolean;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function collabPayload(activity: Thread["activities"][number]): Record<string, unknown> | null {
  const payload = activity.payload;
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  return record.itemType === COLLAB_AGENT_ITEM_TYPE ? record : null;
}

/**
 * Pure fold of a thread's activities into its live top-level subagents. Each
 * `collab_agent_tool_call` activity is keyed by `toolUseId`: `tool.started` marks it
 * running, `tool.completed` marks it finished, and `parentToolUseId`/`subagentType` are
 * backfilled from whichever activity carries them. A node is top-level when it has no
 * `parentToolUseId` or its parent is unknown (orphan). For each RUNNING top-level node we
 * DFS its children (all levels) to count running descendants. Order follows first-seen.
 */
export function buildRunningSubagentTree(
  activities: ReadonlyArray<Thread["activities"][number]>,
): RunningSubagentRow[] {
  const nodes = new Map<string, SubagentNode>();

  for (const activity of activities) {
    const payload = collabPayload(activity);
    if (!payload) {
      continue;
    }
    const toolUseId = readString(payload, "toolUseId");
    if (!toolUseId) {
      continue;
    }
    let node = nodes.get(toolUseId);
    if (!node) {
      node = { toolUseId, parentToolUseId: undefined, subagentType: undefined, running: false };
      nodes.set(toolUseId, node);
    }
    const parentToolUseId = readString(payload, "parentToolUseId");
    if (parentToolUseId) {
      node.parentToolUseId = parentToolUseId;
    }
    const subagentType = readString(payload, "subagentType");
    if (subagentType) {
      node.subagentType = subagentType;
    }
    if (activity.kind === "tool.started") {
      node.running = true;
    } else if (activity.kind === "tool.completed") {
      node.running = false;
    }
  }

  // parent toolUseId -> child toolUseIds (first-seen order)
  const childrenByParent = new Map<string, string[]>();
  for (const node of nodes.values()) {
    if (node.parentToolUseId && nodes.has(node.parentToolUseId)) {
      const siblings = childrenByParent.get(node.parentToolUseId);
      if (siblings) {
        siblings.push(node.toolUseId);
      } else {
        childrenByParent.set(node.parentToolUseId, [node.toolUseId]);
      }
    }
  }

  const countRunningDescendants = (toolUseId: string, seen: Set<string>): number => {
    if (seen.has(toolUseId)) {
      return 0;
    }
    seen.add(toolUseId);
    let count = 0;
    for (const childId of childrenByParent.get(toolUseId) ?? []) {
      const child = nodes.get(childId);
      if (!child) {
        continue;
      }
      if (child.running) {
        count += 1;
      }
      count += countRunningDescendants(childId, seen);
    }
    return count;
  };

  const rows: RunningSubagentRow[] = [];
  for (const node of nodes.values()) {
    const isTopLevel = !node.parentToolUseId || !nodes.has(node.parentToolUseId);
    if (!node.running || !isTopLevel) {
      continue;
    }
    rows.push({
      subagentType: node.subagentType ?? "agent",
      descendantCount: countRunningDescendants(node.toolUseId, new Set()),
    });
  }
  return rows;
}

/**
 * Live list of running top-level subagents for the active thread, read directly from the
 * client store so the composer can render one `subagent: <type> (+N)` row each without a
 * prop threaded down from ChatView. Returns an empty array when the thread is unknown.
 */
export function useRunningSubagentTree(
  threadId: ThreadId | null | undefined,
): RunningSubagentRow[] {
  const thread = useStore(
    useMemo(() => createThreadSelectorAcrossEnvironments(threadId ?? null), [threadId]),
  );
  const activities = thread?.activities;
  return useMemo(() => (activities ? buildRunningSubagentTree(activities) : []), [activities]);
}
