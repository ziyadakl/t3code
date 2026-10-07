import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  ProviderThreadId,
  RunId,
} from "@t3tools/contracts";

import type { ProjectionRecords } from "./ProjectionStore.ts";

export const NO_FILE_SNAPSHOTS_MESSAGE = "Claude kept no file snapshots for this message.";

/**
 * Whether `run` replays a prompt of the transcript its thread was imported
 * from (imported message ids start with the thread id). Those turns happened
 * before any turn T3 Code ran on the thread, even when a thread that had
 * already run turns recorded them later, with higher ordinals.
 */
export function isImportedTranscriptRun(
  run: Pick<OrchestrationV2Run, "threadId" | "userMessageId">,
): boolean {
  return run.userMessageId.startsWith(`${run.threadId}:`);
}

/** Orders runs as their turns happened: imported transcript prompts first, then by ordinal. */
export function compareConversationOrder(
  left: Pick<OrchestrationV2Run, "threadId" | "userMessageId" | "ordinal">,
  right: Pick<OrchestrationV2Run, "threadId" | "userMessageId" | "ordinal">,
): number {
  return (
    Number(isImportedTranscriptRun(right)) - Number(isImportedTranscriptRun(left)) ||
    left.ordinal - right.ordinal
  );
}

/**
 * The last run before `run` still in the conversation: rewinding to the
 * message of `run` keeps the conversation up to its end. Undefined means the
 * rewind goes back to the thread start.
 */
export function previousConversationRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
  run: OrchestrationV2Run,
): OrchestrationV2Run | undefined {
  return runs
    .filter(
      (candidate) =>
        compareConversationOrder(candidate, run) < 0 && candidate.status !== "rolled_back",
    )
    .toSorted(compareConversationOrder)
    .at(-1);
}

/**
 * Where a rewind to the thread start resumes the provider session: in a chat
 * imported from the middle of a Claude transcript, where the transcript before
 * its first recorded prompt ends, so that earlier context stays. Undefined:
 * the session starts over.
 */
export function threadStartResumeAt(
  providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  providerThreadId: ProviderThreadId,
): string | undefined {
  return providerTurns.find(
    (turn) => turn.providerThreadId === providerThreadId && turn.nativeResumeAt !== undefined,
  )?.nativeResumeAt;
}

/**
 * The provider turn holding the uuid Claude keyed the run's file snapshot by
 * (its user message). A retried run sent it once per attempt; the first one is
 * before any of its edits. Undefined: Claude kept no snapshot for the run.
 */
export function runFileCheckpointTurn(
  projection: Pick<ProjectionRecords<"attempts" | "providerTurns">, "attempts" | "providerTurns">,
  runId: RunId,
) {
  const attemptIds = new Set(
    projection.attempts.filter((attempt) => attempt.runId === runId).map((attempt) => attempt.id),
  );
  return projection.providerTurns
    .filter(
      (turn) =>
        turn.runAttemptId !== null &&
        attemptIds.has(turn.runAttemptId) &&
        turn.nativeUserMessageId !== undefined,
    )
    .toSorted((left, right) => left.ordinal - right.ordinal)[0];
}
