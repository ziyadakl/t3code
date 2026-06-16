import { describe, expect, it } from "vite-plus/test";

import { planScopedRestore } from "./scopedCheckpointRestore.ts";

const COMMIT = "abc123def456abc123def456abc123def456abc1";

describe("planScopedRestore", () => {
  it("returns [] when paths is empty", () => {
    const result = planScopedRestore({
      paths: [],
      presentAtCommit: new Set(["some-file.ts"]),
      commitOid: COMMIT,
      headExists: true,
    });
    expect(result).toEqual([]);
  });

  it("emits only restore + reset when all paths are present at the commit", () => {
    const result = planScopedRestore({
      paths: ["a.ts", "b.ts"],
      presentAtCommit: new Set(["a.ts", "b.ts"]),
      commitOid: COMMIT,
      headExists: true,
    });

    expect(result).toEqual([
      { args: ["restore", "--source", COMMIT, "--worktree", "--staged", "--", "a.ts", "b.ts"] },
      { args: ["reset", "--quiet", "--", "a.ts", "b.ts"] },
    ]);
  });

  it("emits only rm + clean + reset when all paths were created since the checkpoint", () => {
    const result = planScopedRestore({
      paths: ["new1.ts", "new2.ts"],
      presentAtCommit: new Set(),
      commitOid: COMMIT,
      headExists: true,
    });

    expect(result).toEqual([
      { args: ["rm", "-f", "--ignore-unmatch", "--", "new1.ts", "new2.ts"] },
      { args: ["clean", "-fd", "--", "new1.ts", "new2.ts"] },
      { args: ["reset", "--quiet", "--", "new1.ts", "new2.ts"] },
    ]);
  });

  it("emits restore, rm, clean, reset in the correct order for a mixed set", () => {
    const result = planScopedRestore({
      paths: ["existing.ts", "created.ts"],
      presentAtCommit: new Set(["existing.ts"]),
      commitOid: COMMIT,
      headExists: true,
    });

    expect(result).toEqual([
      {
        args: [
          "restore",
          "--source",
          COMMIT,
          "--worktree",
          "--staged",
          "--",
          "existing.ts",
        ],
      },
      { args: ["rm", "-f", "--ignore-unmatch", "--", "created.ts"] },
      { args: ["clean", "-fd", "--", "created.ts"] },
      { args: ["reset", "--quiet", "--", "existing.ts", "created.ts"] },
    ]);
  });

  it("omits the reset command when headExists is false", () => {
    const result = planScopedRestore({
      paths: ["agent.ts"],
      presentAtCommit: new Set(["agent.ts"]),
      commitOid: COMMIT,
      headExists: false,
    });

    expect(result).toEqual([
      { args: ["restore", "--source", COMMIT, "--worktree", "--staged", "--", "agent.ts"] },
      // no reset
    ]);
  });

  it("omits reset for created-only paths when headExists is false", () => {
    const result = planScopedRestore({
      paths: ["orphan.ts"],
      presentAtCommit: new Set(),
      commitOid: COMMIT,
      headExists: false,
    });

    expect(result).toEqual([
      { args: ["rm", "-f", "--ignore-unmatch", "--", "orphan.ts"] },
      { args: ["clean", "-fd", "--", "orphan.ts"] },
      // no reset
    ]);
  });

  it("reset receives ALL paths (present + created), not just present", () => {
    const result = planScopedRestore({
      paths: ["kept.ts", "new.ts"],
      presentAtCommit: new Set(["kept.ts"]),
      commitOid: COMMIT,
      headExists: true,
    });

    const resetCmd = result.find((c) => c.args[0] === "reset");
    expect(resetCmd?.args).toEqual(["reset", "--quiet", "--", "kept.ts", "new.ts"]);
  });

  it("handles a single present path correctly", () => {
    const result = planScopedRestore({
      paths: ["solo.ts"],
      presentAtCommit: new Set(["solo.ts"]),
      commitOid: COMMIT,
      headExists: true,
    });

    expect(result).toHaveLength(2);
    expect(result[0]?.args).toEqual([
      "restore",
      "--source",
      COMMIT,
      "--worktree",
      "--staged",
      "--",
      "solo.ts",
    ]);
    expect(result[1]?.args).toEqual(["reset", "--quiet", "--", "solo.ts"]);
  });
});
