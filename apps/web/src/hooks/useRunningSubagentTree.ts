import { useMemo } from "react";

import type { ItemLifecyclePayload, ThreadId } from "@t3tools/contracts";

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
  /** Stable identity for React keys — the tool_use_id of this subagent call. */
  toolUseId: string;
  subagentType: string;
  descendantCount: number;
}

type Activity = Thread["activities"][number];

interface SubagentNode {
  toolUseId: string;
  parentToolUseId: string | undefined;
  subagentType: string | undefined;
  running: boolean;
}

/**
 * The projected shape the server emits for a tool-lifecycle activity's payload: the typed
 * {@link ItemLifecyclePayload} fields (`parentToolUseId`/`subagentType`) plus this call's
 * `toolUseId` (spread from the event's `itemId`). Read straight off the typed payload rather
 * than string-probing a `Record<string, unknown>`.
 */
type CollabLifecyclePayload = ItemLifecyclePayload & { toolUseId?: string };

function collabLifecyclePayload(activity: Activity): CollabLifecyclePayload | null {
  const payload = activity.payload;
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const candidate = payload as Partial<CollabLifecyclePayload>;
  return candidate.itemType === COLLAB_AGENT_ITEM_TYPE
    ? (candidate as CollabLifecyclePayload)
    : null;
}

/**
 * Pure fold of a thread's activities into its live top-level subagents. Each
 * `collab_agent_tool_call` activity is keyed by `toolUseId`: `tool.started` marks it
 * running, `tool.completed` marks it finished, and `parentToolUseId`/`subagentType` are
 * backfilled from whichever activity carries them.
 *
 * A RUNNING node is a top-level *row* when it has no RUNNING ancestor (its nearest running
 * ancestor is absent — the parent chain is unknown, or every ancestor has already flipped
 * `running=false`). This guarantees every running subagent is accounted for exactly once:
 * a still-running child whose parent already completed surfaces as its own row instead of
 * being silently dropped. For each row we count all running descendants at any depth,
 * regardless of intermediate nodes' running state. Order follows first-seen.
 */
export function buildRunningSubagentTree(
  activities: ReadonlyArray<Activity>,
): RunningSubagentRow[] {
  const nodes = new Map<string, SubagentNode>();

  for (const activity of activities) {
    const payload = collabLifecyclePayload(activity);
    if (!payload) {
      continue;
    }
    const toolUseId = payload.toolUseId;
    if (typeof toolUseId !== "string" || toolUseId.length === 0) {
      continue;
    }
    let node = nodes.get(toolUseId);
    if (!node) {
      node = { toolUseId, parentToolUseId: undefined, subagentType: undefined, running: false };
      nodes.set(toolUseId, node);
    }
    if (payload.parentToolUseId) {
      node.parentToolUseId = payload.parentToolUseId;
    }
    if (payload.subagentType) {
      node.subagentType = payload.subagentType;
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

  // Walk the parent chain; a node is promoted to a row only when no ancestor is still
  // running. Cycle-guarded so a malformed parent loop terminates.
  const hasRunningAncestor = (node: SubagentNode): boolean => {
    const seen = new Set<string>([node.toolUseId]);
    let parentId = node.parentToolUseId;
    while (parentId && !seen.has(parentId)) {
      const parent = nodes.get(parentId);
      if (!parent) {
        return false;
      }
      if (parent.running) {
        return true;
      }
      seen.add(parentId);
      parentId = parent.parentToolUseId;
    }
    return false;
  };

  // Count every running descendant at any depth. Each node is visited at most once (the
  // `seen` guard sits BEFORE the increment) so a malformed parent cycle can't double-count.
  const countRunningDescendants = (rootId: string): number => {
    const seen = new Set<string>([rootId]);
    const stack = [...(childrenByParent.get(rootId) ?? [])];
    let count = 0;
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined || seen.has(id)) {
        continue;
      }
      seen.add(id);
      const node = nodes.get(id);
      if (!node) {
        continue;
      }
      if (node.running) {
        count += 1;
      }
      for (const childId of childrenByParent.get(id) ?? []) {
        stack.push(childId);
      }
    }
    return count;
  };

  const rows: RunningSubagentRow[] = [];
  for (const node of nodes.values()) {
    if (!node.running || hasRunningAncestor(node)) {
      continue;
    }
    rows.push({
      toolUseId: node.toolUseId,
      subagentType: node.subagentType ?? "agent",
      descendantCount: countRunningDescendants(node.toolUseId),
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
