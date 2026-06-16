import { describe, expect, it } from "vite-plus/test";

import { agentEditSetForUndoneSpan } from "./agentEditSetForRestore.ts";

const CWD = "/repo";

// A file_change tool activity on a given turn, path at data.input.file_path.
function fileChange(turnId: string | null, filePath: string) {
  return {
    kind: "tool.completed",
    turnId,
    payload: { itemType: "file_change", data: { input: { file_path: filePath } } },
  };
}

describe("agentEditSetForUndoneSpan", () => {
  // turn-0 = checkpointTurnCount 0, turn-1 = 1, etc.
  const checkpoints = [
    { turnId: "turn-0", checkpointTurnCount: 0 },
    { turnId: "turn-1", checkpointTurnCount: 1 },
    { turnId: "turn-2", checkpointTurnCount: 2 },
  ];

  it("collects agent-edited paths from turns after the restore target, repo-relative", () => {
    const paths = agentEditSetForUndoneSpan({
      activities: [fileChange("turn-2", "/repo/src/a.ts")],
      checkpoints,
      targetTurnCount: 1,
      cwd: CWD,
    });
    expect(paths).toEqual(["src/a.ts"]);
  });

  it("excludes edits from turns at or before the restore target (not being undone)", () => {
    const paths = agentEditSetForUndoneSpan({
      activities: [
        fileChange("turn-1", "/repo/kept.ts"), // target turn — not undone
        fileChange("turn-2", "/repo/undone.ts"), // after target — undone
      ],
      checkpoints,
      targetTurnCount: 1,
      cwd: CWD,
    });
    expect(paths).toEqual(["undone.ts"]);
  });

  it("excludes files the agent only read, even in an undone turn", () => {
    const read = {
      kind: "tool.completed",
      turnId: "turn-2",
      payload: { itemType: "command_execution", data: { input: { file_path: "/repo/seen.ts" } } },
    };
    expect(
      agentEditSetForUndoneSpan({ activities: [read], checkpoints, targetTurnCount: 1, cwd: CWD }),
    ).toEqual([]);
  });

  it("drops paths that resolve outside the worktree", () => {
    const paths = agentEditSetForUndoneSpan({
      activities: [fileChange("turn-2", "/elsewhere/evil.ts")],
      checkpoints,
      targetTurnCount: 1,
      cwd: CWD,
    });
    expect(paths).toEqual([]);
  });

  it("keeps already-relative paths and ignores activities with no turn", () => {
    const paths = agentEditSetForUndoneSpan({
      activities: [
        fileChange("turn-2", "rel/b.ts"), // already relative
        fileChange(null, "/repo/orphan.ts"), // no turn → excluded
      ],
      checkpoints,
      targetTurnCount: 1,
      cwd: CWD,
    });
    expect(paths).toEqual(["rel/b.ts"]);
  });
});
