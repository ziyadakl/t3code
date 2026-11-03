// Fork (Claude rewind): the rewind menu's decisions, kept out of Upstream's ChatView.logic.ts,
// session-logic.ts and MessagesTimeline.logic.ts. Pure functions; `useMessageRewind` drives them.
import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import {
  type CommandId,
  type EnvironmentId,
  type MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadRewindPreview,
  type RunId,
  type ScopedThreadRef,
  THREAD_REWIND_CHOICES,
  type ThreadId,
  type ThreadRewindChoice,
  threadRewindPreviewOffersCode,
  threadRewindRestores,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { deriveRevertTurnCountByUserMessageId, type TimelineEntry } from "../../session-logic";
import { orchestrationEnvironment } from "../../state/orchestration";
import { formatEnvironmentQueryError } from "../../state/query";
import { environmentThreadDetails } from "../../state/threads";
import { waitForAtomValue } from "../../state/waitForAtomValue";
import type { ChatMessage } from "../../types";

/**
 * Resolves with the thread's runs once none is live, the server's condition
 * for a rewind (Orchestrator `hasLiveRun`), after Stop was sent. Rejects when
 * the run has not stopped within `timeoutMs`.
 */
export async function waitForThreadToStop(
  threadRef: ScopedThreadRef,
  timeoutMs = 15_000,
): Promise<ReadonlyArray<OrchestrationV2Run>> {
  const threadAtom = environmentThreadDetails.stateAtom(threadRef);
  const stopped = await waitForAtomValue({
    registry: appAtomRegistry,
    atom: threadAtom,
    predicate: (state) => {
      const projection = Option.getOrNull(state.data);
      return (
        projection !== null &&
        !projection.runs.some(
          (run) =>
            run.status === "preparing" || run.status === "starting" || run.status === "running",
        )
      );
    },
    timeoutMs,
  });
  if (!stopped) throw new Error("The current turn did not stop. Press Stop, then rewind again.");
  return Option.getOrNull(appAtomRegistry.get(threadAtom).data)?.runs ?? [];
}
/**
 * Why a message rewind cannot start now, or null. A queued message, even one
 * Stop held, would be sent into the rewound chat; the server refuses it too.
 */
export function messageRewindBlockedReason(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "status" | "queueHeld">>,
): string | null {
  return runs.some((run) => run.status === "queued")
    ? "Send or remove your queued messages before rewinding."
    : null;
}

/** One row of the rewind menu; an unavailable row shows, disabled, in its place. */
export interface MessageRewindMenuRow {
  readonly choice: ThreadRewindChoice;
  readonly available: boolean;
}

/**
 * The rewind menu for one sent message: every choice T3 Code can carry out, in Claude Code's
 * order. The code choices stay disabled until Claude's dry run says a restore would change a
 * file, so no row moves when it returns. `note` says what a code restore does, or why none.
 */
export function deriveMessageRewindMenu(input: {
  /** Null while the dry run is in flight, or when it failed. */
  readonly preview: OrchestrationV2ThreadRewindPreview | null;
  readonly error: string | null;
}): { readonly rows: ReadonlyArray<MessageRewindMenuRow>; readonly note: string | null } {
  const offersCode = input.preview !== null && threadRewindPreviewOffersCode(input.preview);
  const rows = THREAD_REWIND_CHOICES.flatMap((choice) => {
    const restores = threadRewindRestores(choice);
    return restores === null ? [] : [{ choice, available: !restores.code || offersCode }];
  });
  if (input.preview === null) {
    return {
      rows,
      note:
        input.error === null
          ? "Checking for code changes..."
          : `Could not check for code changes: ${input.error}`,
    };
  }
  if (!offersCode) {
    return {
      rows,
      note: input.preview.unavailableReason ?? "Claude changed no files after this message.",
    };
  }
  const files = input.preview.filesChanged.length;
  return {
    rows,
    note: `Restoring code changes ${files === 1 ? "1 file" : `${files} files`} (+${input.preview.insertions} -${input.preview.deletions}).`,
  };
}

/**
 * Fetches Claude's dry run of a code restore for one message through the
 * query the rewind menu reads. The query stays mounted until `release`, so a
 * menu opened before then shows the answer without checking again. Answers
 * `{ preview: null, error: null }` when the dry run is still out at the timeout.
 */
export async function loadThreadRewindPreview(
  target: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  },
  timeoutMs = 20_000,
): Promise<{
  readonly preview: OrchestrationV2ThreadRewindPreview | null;
  readonly error: string | null;
  readonly release: () => void;
}> {
  const atom = orchestrationEnvironment.threadRewindPreview({
    environmentId: target.environmentId,
    input: { threadId: target.threadId, messageId: target.messageId },
  });
  const release = appAtomRegistry.subscribe(atom, () => {});
  await waitForAtomValue({
    registry: appAtomRegistry,
    atom,
    predicate: (result) => result._tag !== "Initial" && !result.waiting,
    timeoutMs,
  });
  // Only a settled answer counts: a stale success while refetching is not one.
  const result = appAtomRegistry.get(atom);
  if (result.waiting) return { preview: null, error: null, release };
  return {
    preview: result._tag === "Success" ? result.value : null,
    error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
    release,
  };
}
/**
 * The next step of a click on a message's rewind arrow; call again with `afterStop` and the
 * settled runs after `stop-first` (interrupt, wait). `refuse`: show `reason` (a Claude queue
 * is refused before any Stop); `check-files`: dry run, then `decideMessageRewindStart`;
 * `ask`: open the dialog (other providers after a Stop); `revert`: rewind now.
 */
export function planMessageRewind(input: {
  readonly canInterrupt: boolean;
  readonly isWorking: boolean;
  readonly supportsMessageRewind: boolean;
  readonly afterStop: boolean;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "status" | "queueHeld">>;
}):
  | { readonly kind: "refuse"; readonly reason: string }
  | { readonly kind: "stop-first" | "check-files" | "ask" | "revert" } {
  const blockedReason = input.supportsMessageRewind ? messageRewindBlockedReason(input.runs) : null;
  if (blockedReason !== null) return { kind: "refuse", reason: blockedReason };
  if (input.canInterrupt) return { kind: "stop-first" };
  if (input.isWorking) {
    // Sending, or work no Stop reaches: nothing to stop, so wait.
    return { kind: "refuse", reason: "Wait for the current work to finish before rewinding." };
  }
  if (input.supportsMessageRewind) return { kind: "check-files" };
  return input.afterStop ? { kind: "ask" } : { kind: "revert" };
}
/**
 * What a click on a Claude message's rewind arrow does once the dry run is
 * back: rewind the conversation at once when no code choice could apply, or
 * open the rewind menu. No answer (the dry run failed or timed out) always asks.
 */
export function decideMessageRewindStart(input: {
  readonly preview: OrchestrationV2ThreadRewindPreview | null;
}): { readonly kind: "rewind-now" } | { readonly kind: "ask" } {
  return input.preview !== null && !threadRewindPreviewOffersCode(input.preview)
    ? { kind: "rewind-now" }
    : { kind: "ask" };
}

/**
 * Whether reverting to `turnCount` earlier turns could change files: a later
 * run recorded file changes, or its checkpoint is missing so its changes are
 * unknown. Rolled-back (stale) checkpoints no longer count. When this is false
 * the revert keeps the workspace without asking about files.
 */
export function revertTouchesFiles(
  checkpoints: ReadonlyArray<ThreadCheckpointSummary>,
  turnCount: number,
): boolean {
  return checkpoints.some(
    (checkpoint) =>
      checkpoint.checkpointTurnCount > turnCount &&
      checkpoint.status !== "stale" &&
      (checkpoint.status !== "ready" || checkpoint.files.length > 0),
  );
}

/**
 * Claude threads rewind to any sent message that started a turn, with or
 * without a file checkpoint; the server refuses what it cannot do. The value
 * is how many earlier turns the rewind keeps.
 */
export function deriveRewindTurnCountByUserMessageId(
  timelineEntries: ReadonlyArray<TimelineEntry>,
): Map<ChatMessage["id"], number> {
  const byUserMessageId = new Map<ChatMessage["id"], number>();
  for (const entry of timelineEntries) {
    if (entry.kind !== "message" || entry.message.role !== "user") continue;
    if (entry.message.inputIntent !== "turn_start" && entry.message.inputIntent !== "queued_turn") {
      continue;
    }
    if (entry.message.runId === null) continue;
    byUserMessageId.set(entry.message.id, byUserMessageId.size);
  }
  return byUserMessageId;
}

/**
 * Which sent messages a thread can rewind to, and how many earlier turns each
 * rewind keeps. The rewind arrows and the rewind picker share it, so both
 * offer the same messages.
 */
export function deriveMessageRewindTargets(input: {
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly turnDiffSummaries: ReadonlyArray<ThreadCheckpointSummary>;
  readonly supportsConversationRollback: boolean;
  readonly supportsMessageRewind: boolean;
  readonly threadStartCheckpointReady?: boolean;
  readonly availableRevertTurnCounts?: ReadonlySet<number> | undefined;
  readonly unsettledRunId?: RunId | null;
}): Map<ChatMessage["id"], number> {
  if (input.supportsMessageRewind) {
    return deriveRewindTurnCountByUserMessageId(input.timelineEntries);
  }
  if (input.supportsConversationRollback) {
    return deriveRevertTurnCountByUserMessageId({
      timelineEntries: input.timelineEntries,
      checkpoints: input.turnDiffSummaries,
      threadStartCheckpointReady: input.threadStartCheckpointReady === true,
      availableRevertTurnCounts: input.availableRevertTurnCounts,
      unsettledRunId: input.unsettledRunId ?? null,
    });
  }
  return new Map();
}

/**
 * The rewind arrow is off during a rewind and while work runs that no Stop
 * reaches; a stoppable turn leaves it on, since the click stops the turn first.
 */
export function isMessageRewindDisabled(input: {
  isRevertingCheckpoint: boolean;
  isWorking: boolean;
  canInterrupt: boolean;
}): boolean {
  return input.isRevertingCheckpoint || (input.isWorking && !input.canInterrupt);
}

/**
 * Runs `revert` (command `requestId`); resolves with the server's notice once the message's run is
 * rolled back or the thread records the rewind done, rejects on a recorded failure. `awaitsRecordedOutcome`
 * waits for the record; `turnCount` bounds the wait to the retained runs when the message is paged out.
 */
export async function waitForRewindOutcome(
  threadRef: ScopedThreadRef,
  messageId: MessageId,
  requestId: CommandId,
  revert: () => Promise<void>,
  options: {
    readonly awaitsRecordedOutcome?: boolean;
    readonly timeoutMs?: number;
    readonly turnCount?: number;
  } = {},
): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const threadAtom = environmentThreadDetails.stateAtom(threadRef);
  const readProjection = () => Option.getOrNull(appAtomRegistry.get(threadAtom).data);
  const initial = readProjection();
  const messageRunId = initial?.messages.find((message) => message.id === messageId)?.runId;
  const targetRun = initial?.runs.find((run) => run.id === messageRunId);
  const isSettledRun = (status: string) =>
    status === "completed" ||
    status === "interrupted" ||
    status === "failed" ||
    status === "cancelled";
  const turnCount = options.turnCount;
  // Paging can omit the message and its run. The rollback commits the whole settled suffix at once.
  const pagedOutWitness =
    targetRun === undefined && turnCount !== undefined
      ? initial?.runs.reduce<(typeof initial.runs)[number] | undefined>(
          (latest, run) =>
            run.ordinal <= turnCount || !isSettledRun(run.status)
              ? latest
              : latest === undefined || run.ordinal > latest.ordinal
                ? run
                : latest,
          undefined,
        )
      : undefined;
  if (targetRun === undefined && pagedOutWitness === undefined) {
    throw new Error(
      turnCount === undefined
        ? "The message to rewind is no longer available."
        : "The thread has changed. Select a message to rewind again.",
    );
  }
  if (targetRun?.status === "rolled_back") {
    throw new Error("The thread has changed. Select a message to rewind again.");
  }
  return new Promise<string | null>((resolve, reject) => {
    let settled = false;
    let accepted = false;
    let unsubscribe = () => {};
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    const finish = (error?: unknown, notice: string | null = null) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
      unsubscribe();
      if (error !== undefined) reject(error);
      else resolve(notice);
    };
    const inspect = () => {
      const thread = readProjection();
      if (!thread) return;
      const failure = thread.thread.rollbackFailure;
      if (failure?.requestId === requestId) {
        finish(new Error(failure.message));
        return;
      }
      const completion = thread.thread.rollbackCompletion;
      if (completion?.requestId === requestId) {
        finish(undefined, completion.notice ?? null);
        return;
      }
      if (
        accepted &&
        (options.awaitsRecordedOutcome !== true || thread.thread.rollbackRequestId !== requestId) &&
        (pagedOutWitness === undefined
          ? thread.runs.some((run) => run.id === messageRunId && run.status === "rolled_back")
          : thread.runs.some(
              (run) => run.id === pagedOutWitness.id && run.status === "rolled_back",
            ) &&
            !thread.runs.some((run) => run.ordinal > (turnCount ?? 0) && isSettledRun(run.status)))
      )
        finish();
    };
    unsubscribe = appAtomRegistry.subscribe(threadAtom, inspect);
    timeout = globalThis.setTimeout(() => {
      finish(new Error("Timed out waiting for the thread to rewind."));
    }, timeoutMs);
    Promise.resolve()
      .then(revert)
      .then(() => {
        accepted = true;
        inspect();
      }, finish);
  });
}
