/**
 * The checkpoint holding the workspace as it stood after run `runOrdinal`. A
 * run that never started (cancelled while queued, or steered into an earlier
 * run) captures no checkpoint, so the newest checkpoint at or before the
 * ordinal stands for it. Undefined means only the thread-start state remains.
 */
export function newestCheckpointAtOrBefore<
  Checkpoint extends { readonly appRunOrdinal: number | null },
>(checkpoints: ReadonlyArray<Checkpoint>, runOrdinal: number): Checkpoint | undefined {
  let newest: Checkpoint | undefined;
  let newestOrdinal = 0;
  for (const candidate of checkpoints) {
    const ordinal = candidate.appRunOrdinal;
    if (ordinal === null || ordinal > runOrdinal || ordinal < newestOrdinal) continue;
    newest = candidate;
    newestOrdinal = ordinal;
  }
  return newest;
}
