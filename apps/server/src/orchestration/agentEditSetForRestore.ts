// @effect-diagnostics nodeBuiltinImport:off
import path from "node:path";

import { agentEditSet, type ToolActivityLike } from "@t3tools/shared/agentEditSet";

/**
 * Derives the repo-relative **Agent edit set** for a file-restore to a target
 * checkpoint — the files the agent itself changed across the turns being undone
 * (those with `checkpointTurnCount` greater than the restore target). The result
 * is the `paths` passed to `CheckpointStore.restoreCheckpoint`, so the restore
 * touches only the agent's files and never the user's. See
 * docs/adr/0004-author-scoped-file-restore.md.
 *
 * Server-side (uses `node:path` for normalization), so it lives here rather than
 * in the shared `agentEditSet` module that the web bundle also imports.
 */
export function agentEditSetForUndoneSpan(input: {
  readonly activities: ReadonlyArray<ToolActivityLike & { readonly turnId: string | null }>;
  readonly checkpoints: ReadonlyArray<{
    readonly turnId: string;
    readonly checkpointTurnCount: number;
  }>;
  readonly targetTurnCount: number;
  readonly cwd: string;
}): string[] {
  const turnCountByTurnId = new Map<string, number>();
  for (const checkpoint of input.checkpoints) {
    turnCountByTurnId.set(checkpoint.turnId, checkpoint.checkpointTurnCount);
  }

  // Activities belonging to a turn that is being undone (i.e. captured AFTER the
  // restore target). Activities with no resolvable turn are excluded.
  const undoneActivities = input.activities.filter((activity) => {
    if (activity.turnId === null) return false;
    const checkpointTurnCount = turnCountByTurnId.get(activity.turnId);
    return checkpointTurnCount !== undefined && checkpointTurnCount > input.targetTurnCount;
  });

  const out: string[] = [];
  const seen = new Set<string>();
  for (const harvested of agentEditSet(undoneActivities)) {
    const relative = path.isAbsolute(harvested) ? path.relative(input.cwd, harvested) : harvested;
    // Defensive: never let a path outside the worktree leak into the git
    // pathspec (a stray absolute path from another root would otherwise widen
    // the restore scope).
    if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
      continue;
    }
    if (seen.has(relative)) continue;
    seen.add(relative);
    out.push(relative);
  }
  return out;
}
