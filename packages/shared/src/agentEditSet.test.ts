import { describe, expect, it } from "@effect/vitest";

import { agentEditSet, editedPathsForActivity } from "./agentEditSet.ts";

// A Claude Edit/Write tool activity: the path lives at data.input.file_path
// (snake_case). This is the case the legacy web harvester silently missed.
function claudeEdit(filePath: string, kind = "tool.completed") {
  return {
    kind,
    payload: {
      itemType: "file_change",
      data: { toolName: "Edit", input: { file_path: filePath } },
    },
  };
}

describe("agentEditSet", () => {
  it("captures a Claude file-change edit (data.input.file_path)", () => {
    expect(editedPathsForActivity(claudeEdit("/repo/src/a.ts"))).toEqual(["/repo/src/a.ts"]);
  });

  it("ignores a file the agent only read (not a file_change activity)", () => {
    const read = {
      kind: "tool.completed",
      payload: {
        itemType: "command_execution",
        data: { toolName: "Read", input: { file_path: "/repo/src/secret.ts" } },
      },
    };
    expect(editedPathsForActivity(read)).toEqual([]);
  });

  it("captures a Codex apply_patch multi-file change (data.item.changes[].path)", () => {
    const codex = {
      kind: "tool.completed",
      payload: {
        itemType: "file_change",
        data: { item: { type: "fileChange", changes: [{ path: "/a.ts" }, { path: "/b.ts" }] } },
      },
    };
    expect(editedPathsForActivity(codex)).toEqual(["/a.ts", "/b.ts"]);
  });

  it("unions the edit set across a span of turns, de-duped in first-seen order", () => {
    const activities = [
      claudeEdit("/a.ts"),
      { kind: "tool.completed", payload: { itemType: "command_execution", data: { input: { file_path: "/ran.sh" } } } },
      claudeEdit("/b.ts"),
      claudeEdit("/a.ts"), // touched again in a later turn → not duplicated
    ];
    expect(agentEditSet(activities)).toEqual(["/a.ts", "/b.ts"]);
  });
});
