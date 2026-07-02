import { useMemo } from "react";

import type { ThreadId } from "@t3tools/contracts";

import { useStore } from "../store";
import { createThreadSelectorAcrossEnvironments } from "../storeSelectors";
import type { Thread } from "../types";

/**
 * A subagent launch surfaces as a `collab_agent_tool_call` tool-lifecycle activity:
 * a `tool.started` when it spins up and a `tool.completed` when it finishes (see
 * apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts and projector.ts).
 * The number still running is simply how many have started but not yet completed.
 */
const COLLAB_AGENT_ITEM_TYPE = "collab_agent_tool_call";

function isCollabAgentActivity(activity: Thread["activities"][number]): boolean {
  const payload = activity.payload;
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  return (payload as { itemType?: unknown }).itemType === COLLAB_AGENT_ITEM_TYPE;
}

/**
 * Pure count of top-level subagents currently running for a thread: the number of
 * `collab_agent_tool_call` starts minus completions. Non-collab activities are ignored,
 * and the result never drops below 0.
 */
export function countRunningSubagents(
  activities: ReadonlyArray<Thread["activities"][number]>,
): number {
  let running = 0;
  for (const activity of activities) {
    if (!isCollabAgentActivity(activity)) {
      continue;
    }
    if (activity.kind === "tool.started") {
      running += 1;
    } else if (activity.kind === "tool.completed") {
      running -= 1;
    }
  }
  return running > 0 ? running : 0;
}

/**
 * Live count of top-level subagents currently running for the active thread, read
 * directly from the client store so the composer can display it without a prop threaded
 * down from ChatView. Returns 0 when the thread is unknown or nothing is running.
 */
export function useRunningSubagentCount(threadId: ThreadId | null | undefined): number {
  const thread = useStore(
    useMemo(() => createThreadSelectorAcrossEnvironments(threadId ?? null), [threadId]),
  );
  const activities = thread?.activities;
  return useMemo(() => (activities ? countRunningSubagents(activities) : 0), [activities]);
}
