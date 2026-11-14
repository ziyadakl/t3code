import {
  latestProviderTurnForAttempt,
  type MessageId,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  ProviderThreadId,
  RunId,
  type ThreadId,
  ThreadRewindChoice,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import type { ProjectionRecords } from "./ProjectionStore.ts";

/**
 * The outbox request that rewinds to just before the user message that started
 * `runId`. It lives here, not in `ThreadRewindService`, so `EffectOutbox` can
 * name it without importing the orchestrator.
 */
export const ProviderThreadRewindRequest = Schema.Struct({
  type: Schema.Literal("provider-thread.rewind"),
  providerThreadId: ProviderThreadId,
  runId: RunId,
  choice: ThreadRewindChoice,
});

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
 * Whether Claude ever took a turn for `run`. A run stopped before Claude
 * answered has none, so a rewind has nothing to resume at in it.
 */
function runHasProviderTurn(
  projection: Pick<ProjectionRecords<"attempts" | "providerTurns">, "attempts" | "providerTurns">,
  run: OrchestrationV2Run,
): boolean {
  if (run.activeAttemptId === null) return false;
  if (latestProviderTurnForAttempt(projection.providerTurns, run.activeAttemptId) !== undefined) {
    return true;
  }
  const providerTurnId = projection.attempts.find(
    (attempt) => attempt.id === run.activeAttemptId,
  )?.providerTurnId;
  return projection.providerTurns.some((turn) => turn.id === providerTurnId);
}

/**
 * The last run before `run` still in the conversation and answered by Claude:
 * rewinding to the message of `run` keeps the conversation up to its end. A
 * run stopped before Claude answered is skipped, since it left no turn to
 * resume at. Undefined means the rewind goes back to the thread start.
 */
export function previousConversationRun(
  projection: Pick<
    ProjectionRecords<"runs" | "attempts" | "providerTurns">,
    "runs" | "attempts" | "providerTurns"
  >,
  run: OrchestrationV2Run,
): OrchestrationV2Run | undefined {
  return projection.runs
    .filter(
      (candidate) =>
        compareConversationOrder(candidate, run) < 0 &&
        candidate.status !== "rolled_back" &&
        runHasProviderTurn(projection, candidate),
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

/**
 * The ordinals of the runs after run `targetOrdinal` in conversation order, and
 * the settled ones among them. "After the target" follows conversation order, not
 * ordinals: imported prompts come first but are numbered after the turns T3 Code
 * ran. Only ids are read here, so an obsolete payload cannot fail this read.
 */
export const rollbackAfterOrdinals = Effect.fn("ThreadRewindTargets.rollbackAfterOrdinals")(
  function* (sql: SqlClient.SqlClient, threadId: ThreadId, targetOrdinal: number) {
    const targetRunRows = yield* sql<{ readonly userMessageId: MessageId | null }>`
            SELECT json_extract(payload_json, '$.userMessageId') AS "userMessageId"
            FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId} AND ordinal = ${targetOrdinal}`;
    const targetRun =
      targetRunRows[0]?.userMessageId == null
        ? undefined
        : {
            threadId,
            userMessageId: targetRunRows[0].userMessageId,
            ordinal: targetOrdinal,
          };
    // An imported target has the turns T3 Code ran, numbered lower, after it.
    const candidateRows = yield* sql<{
      readonly ordinal: number;
      readonly status: string;
      readonly userMessageId: MessageId | null;
    }>`SELECT ordinal, status, json_extract(payload_json, '$.userMessageId') AS "userMessageId"
            FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId}
              AND (ordinal > ${targetOrdinal}
                OR (${targetRun !== undefined && isImportedTranscriptRun(targetRun) ? 1 : 0} = 1))`;
    const afterRuns = candidateRows.filter((candidate) =>
      targetRun === undefined
        ? candidate.ordinal > targetOrdinal
        : compareConversationOrder(
            {
              threadId,
              userMessageId: candidate.userMessageId ?? ("" as MessageId),
              ordinal: candidate.ordinal,
            },
            targetRun,
          ) > 0,
    );
    return {
      afterOrdinals: afterRuns.map((candidate) => candidate.ordinal),
      settledAfterOrdinals: afterRuns
        .filter((candidate) =>
          ["completed", "interrupted", "failed", "cancelled"].includes(candidate.status),
        )
        .map((candidate) => candidate.ordinal),
    };
  },
);
