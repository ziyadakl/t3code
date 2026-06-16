import * as Effect from "effect/Effect";

import type { VcsError } from "@t3tools/contracts";
import type * as VcsProcess from "./VcsProcess.ts";

/**
 * Describes a single git command to run as part of a scoped restore.
 * Each entry is an arg-vector passed directly to execute.
 */
export interface ScopedRestoreCommand {
  readonly args: ReadonlyArray<string>;
}

/**
 * Pure planner: computes the ordered list of git arg-vectors needed to
 * restore exactly the given paths to a checkpoint commit.
 *
 * Partition rules (Quality #3 — required):
 *   - Paths present at the commit  → git restore --source
 *   - Paths absent at the commit   → git rm + git clean (undo agent creation)
 *
 * Arg-vector order matches the original inline implementation exactly so
 * behavior is preserved.
 *
 * Returns [] when paths is empty (caller short-circuits before this).
 */
export function planScopedRestore(input: {
  readonly paths: ReadonlyArray<string>;
  readonly presentAtCommit: ReadonlySet<string>;
  readonly commitOid: string;
  readonly headExists: boolean;
}): Array<ScopedRestoreCommand> {
  const { paths, presentAtCommit, commitOid, headExists } = input;

  if (paths.length === 0) {
    return [];
  }

  const present: string[] = [];
  const created: string[] = [];

  for (const p of paths) {
    if (presentAtCommit.has(p)) {
      present.push(p);
    } else {
      created.push(p);
    }
  }

  const commands: ScopedRestoreCommand[] = [];

  // 1. Restore files that existed at the checkpoint (modifications + deletions).
  if (present.length > 0) {
    commands.push({
      args: ["restore", "--source", commitOid, "--worktree", "--staged", "--", ...present],
    });
  }

  // 2. Undo agent-created files (absent at the checkpoint).
  if (created.length > 0) {
    commands.push({ args: ["rm", "-f", "--ignore-unmatch", "--", ...created] });
    commands.push({ args: ["clean", "-fd", "--", ...created] });
  }

  // 3. Reset the index for all paths so staged state matches the worktree.
  if (headExists) {
    commands.push({ args: ["reset", "--quiet", "--", ...paths] });
  }

  return commands;
}

/**
 * The function type that matches the execute closure inside makeVcsDriverShape.
 * Defined here so both the orchestrator and GitVcsDriver can reference it
 * without importing an internal closure type.
 */
export type ExecuteFn = (
  input: Omit<VcsProcess.VcsProcessInput, "command">,
) => Effect.Effect<VcsProcess.VcsProcessOutput, VcsError>;

/**
 * Orchestrator: wires the planner to real git execution.
 *
 * Improvements over the original inline implementation:
 *   - Batch probe: replaces N individual cat-file -e calls with a single
 *     git ls-tree -r -z call to determine which paths existed at the commit.
 *   - Testable seam: planScopedRestore is pure and unit-tested separately.
 */
export const runScopedRestore = (input: {
  readonly cwd: string;
  readonly commitOid: string;
  readonly paths: ReadonlyArray<string>;
  readonly execute: ExecuteFn;
  readonly hasHeadCommit: (cwd: string) => Effect.Effect<boolean, VcsError>;
}): Effect.Effect<boolean, VcsError> =>
  Effect.gen(function* () {
    const { cwd, commitOid, paths, execute, hasHeadCommit } = input;
    const operation = "GitVcsDriver.checkpoints.restoreCheckpoint.scoped";

    if (paths.length === 0) {
      return true;
    }

    // Batched probe: one ls-tree call instead of N cat-file -e calls (Quality #2).
    // ls-tree prints NUL-separated names of paths that exist at the commit.
    // allowNonZeroExit: git ls-tree exits non-zero when the commit has no tree
    // (e.g. brand-new repo) — that's fine, stdout is empty → presentAtCommit is empty.
    const lsTreeResult = yield* execute({
      operation,
      cwd,
      args: ["ls-tree", "-r", "-z", "--name-only", commitOid, "--", ...paths],
      allowNonZeroExit: true,
    });

    const presentAtCommit = new Set<string>(
      lsTreeResult.stdout
        .split("\0")
        .map((p) => p.trim())
        .filter((p) => p.length > 0),
    );

    const headExists = yield* hasHeadCommit(cwd);

    const commands = planScopedRestore({ paths, presentAtCommit, commitOid, headExists });

    for (const command of commands) {
      yield* execute({ operation, cwd, args: command.args });
    }

    return true;
  });
