import { describe, expect, it } from "vite-plus/test";

import { countRunningSubagents } from "./useRunningSubagentCount";
import type { Thread } from "../types";

type Activity = Thread["activities"][number];

function activity(
  kind: string,
  itemType: string | undefined,
  id = `${kind}-${itemType}-${Math.random()}`,
): Activity {
  return {
    id,
    tone: "tool",
    kind,
    summary: "Task",
    payload: itemType === undefined ? {} : { itemType },
    turnId: null,
    createdAt: "2026-07-01T00:00:00.000Z",
  } as unknown as Activity;
}

describe("countRunningSubagents", () => {
  it("counts started minus completed collab_agent_tool_call activities", () => {
    const activities = [
      activity("tool.started", "collab_agent_tool_call", "a"),
      activity("tool.started", "collab_agent_tool_call", "b"),
      activity("tool.completed", "collab_agent_tool_call", "c"),
    ];
    expect(countRunningSubagents(activities)).toBe(1);
  });

  it("returns 0 when every started subagent has completed", () => {
    const activities = [
      activity("tool.started", "collab_agent_tool_call", "a"),
      activity("tool.started", "collab_agent_tool_call", "b"),
      activity("tool.completed", "collab_agent_tool_call", "c"),
      activity("tool.completed", "collab_agent_tool_call", "d"),
    ];
    expect(countRunningSubagents(activities)).toBe(0);
  });

  it("ignores non-collab_agent_tool_call activities", () => {
    const activities = [
      activity("tool.started", "command_execution", "a"),
      activity("tool.completed", "command_execution", "b"),
      activity("info", undefined, "c"),
      activity("tool.started", "collab_agent_tool_call", "d"),
    ];
    expect(countRunningSubagents(activities)).toBe(1);
  });

  it("never drops below 0 even with extra completions", () => {
    const activities = [
      activity("tool.completed", "collab_agent_tool_call", "a"),
      activity("tool.completed", "collab_agent_tool_call", "b"),
    ];
    expect(countRunningSubagents(activities)).toBe(0);
  });

  it("returns 0 for an empty activity list", () => {
    expect(countRunningSubagents([])).toBe(0);
  });
});
