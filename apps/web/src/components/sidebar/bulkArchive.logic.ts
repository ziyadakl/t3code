import type { ContextMenuItem } from "@t3tools/contracts";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { AsyncResult } from "effect/reactivity";
import type { SidebarThreadSummary } from "../../types";

/**
 * Archives sequentially, like the single-row action run once per thread: a
 * failed archive stops the batch, and threads already archived leave the
 * selection while the rest stay selected for a retry.
 */
export async function archiveSelectedThreadEntries<
  TEntry extends { readonly threadKey: string },
  TResult extends { readonly _tag: "Success" | "Failure" },
>(input: {
  entries: readonly TEntry[];
  archive: (entry: TEntry, onArchived: () => void) => Promise<TResult>;
}): Promise<{
  archivedThreadKeys: readonly string[];
  mutationFailure: Extract<TResult, { readonly _tag: "Failure" }> | null;
  followupFailures: readonly Extract<TResult, { readonly _tag: "Failure" }>[];
}> {
  const archivedThreadKeys: string[] = [];
  const followupFailures: Extract<TResult, { readonly _tag: "Failure" }>[] = [];

  for (const entry of input.entries) {
    let didArchive = false;
    const result = await input.archive(entry, () => {
      didArchive = true;
    });
    if (didArchive || result._tag === "Success") archivedThreadKeys.push(entry.threadKey);
    if (result._tag === "Success") continue;
    const failure = result as Extract<TResult, { readonly _tag: "Failure" }>;
    if (didArchive) {
      followupFailures.push(failure);
      continue;
    }
    return { archivedThreadKeys, mutationFailure: failure, followupFailures };
  }

  return { archivedThreadKeys, mutationFailure: null, followupFailures };
}

function failureMessage(failure: AsyncResult.Failure<unknown, unknown>): string {
  const error = squashAtomCommandFailure(failure);
  return error instanceof Error ? error.message : "An error occurred.";
}

/**
 * Runs a bulk archive (see archiveSelectedThreadEntries) and turns its outcome
 * into error reports and selection updates.
 */
export async function archiveThreadsAndReport<
  TEntry extends { readonly threadKey: string },
>(input: {
  entries: readonly TEntry[];
  archive: (entry: TEntry, onArchived: () => void) => Promise<AtomCommandResult<unknown, unknown>>;
  reportError: (title: string, description: string) => void;
  removeFromSelection: (threadKeys: readonly string[]) => void;
  onAllArchived: (archivedThreadKeys: readonly string[]) => void;
}): Promise<void> {
  const outcome = await archiveSelectedThreadEntries({
    entries: input.entries,
    archive: input.archive,
  });
  for (const failure of outcome.followupFailures) {
    if (isAtomCommandInterrupted(failure)) continue;
    input.reportError("Thread archived, but navigation failed", failureMessage(failure));
  }
  if (outcome.mutationFailure) {
    input.removeFromSelection(outcome.archivedThreadKeys);
    if (!isAtomCommandInterrupted(outcome.mutationFailure)) {
      input.reportError("Failed to archive threads", failureMessage(outcome.mutationFailure));
    }
    return;
  }
  input.onAllArchived(outcome.archivedThreadKeys);
}

/**
 * Bulk archive touches only the threads the single-row "Archive thread"
 * action could take: not already archived and not running. The label counts
 * those targets, and the item stays visible but disabled when there are none,
 * like the single-row item on a running thread.
 */
function isBulkArchivable(thread: Pick<SidebarThreadSummary, "archivedAt" | "runtime">): boolean {
  return thread.archivedAt === null && threadRuntimeCanArchive(thread.runtime);
}

export function buildBulkArchiveContextMenuItem<
  T extends Pick<SidebarThreadSummary, "archivedAt" | "runtime">,
>(input: { threads: readonly T[] }): { item: ContextMenuItem<"archive">; targets: T[] } {
  const targets = input.threads.filter(isBulkArchivable);
  return {
    item: {
      id: "archive",
      label: `Archive (${targets.length})`,
      disabled: targets.length === 0,
    },
    targets,
  };
}

/**
 * Decides how a bulk archive that ran to the end updates the selection. When
 * refreshBulkArchiveTargets skipped threads, only the archived ones leave the
 * selection and a notice says what was skipped.
 */
export function resolveBulkArchiveCompletion(input: {
  archivedThreadKeys: readonly string[];
  skippedCount: number;
}):
  | { selection: "clear" }
  | { selection: "keep-skipped"; notice: { title: string; description: string } } {
  const { archivedThreadKeys, skippedCount } = input;
  if (skippedCount === 0) return { selection: "clear" };
  if (archivedThreadKeys.length === 0) {
    return {
      selection: "keep-skipped",
      notice: {
        title: "Nothing archived",
        description: "The selected threads started running or were already archived.",
      },
    };
  }
  const archivedCount = archivedThreadKeys.length;
  return {
    selection: "keep-skipped",
    notice: {
      title: `Archived ${archivedCount} thread${archivedCount === 1 ? "" : "s"}`,
      description:
        skippedCount === 1
          ? "1 was skipped because it started running or was already archived."
          : `${skippedCount} were skipped because they started running or were already archived.`,
    },
  };
}

/**
 * Re-reads the archive targets picked when the menu opened, so a thread that
 * started running (or was archived, or vanished) while the confirm dialog was
 * open is skipped instead of stopping the batch.
 */
export function refreshBulkArchiveTargets<
  T extends Pick<SidebarThreadSummary, "archivedAt" | "runtime">,
>(targets: readonly T[], current: (target: T) => T | undefined): T[] {
  return targets.flatMap((target) => {
    const latest = current(target);
    return latest && isBulkArchivable(latest) ? [latest] : [];
  });
}
