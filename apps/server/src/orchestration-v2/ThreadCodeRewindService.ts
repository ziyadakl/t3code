import { MessageId, RunId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ProjectionStoreV2, type ProjectionRecords } from "./ProjectionStore.ts";
import type { ProviderAdapterV2RewindFilesResult } from "./ProviderAdapter.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

export class ThreadCodeRewindError extends Schema.TaggedError<ThreadCodeRewindError>()(
  "ThreadCodeRewindError",
  {
    threadId: ThreadId,
    /** Shown to the user as is. */
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const isThreadCodeRewindError = Schema.is(ThreadCodeRewindError);

/** What "Restore code" would change for a message. No files: the code choices stay hidden. */
export interface ThreadCodeRewindPreview {
  readonly filesChanged: ReadonlyArray<string>;
  readonly insertions: number;
  readonly deletions: number;
  /** Why code cannot be restored to before this message. */
  readonly unavailableReason?: string;
}

export const NO_FILE_SNAPSHOTS_MESSAGE = "Claude kept no file snapshots for this message.";

/** The notice for a restore that left files alone, or null when it restored all. */
export function skippedFilesMessage(skippedLinks: number): string | null {
  if (skippedLinks === 0) return null;
  return `Code restored, but ${skippedLinks === 1 ? "1 file was" : `${skippedLinks} files were`} left as they are: a link made them unsafe to write.`;
}

export interface ThreadCodeRewindServiceV2Shape {
  readonly preview: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) => Effect.Effect<ThreadCodeRewindPreview, ThreadCodeRewindError>;
  /** Puts files back as they were before the user message that started `runId`. */
  readonly restore: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<{ readonly skippedLinks: number }, ThreadCodeRewindError>;
}

export class ThreadCodeRewindServiceV2 extends Context.Service<
  ThreadCodeRewindServiceV2,
  ThreadCodeRewindServiceV2Shape
>()("t3/orchestration-v2/ThreadCodeRewindService/ThreadCodeRewindServiceV2") {}

const projectionFields = [
  "providerThreads",
  "providerSessions",
  "runs",
  "attempts",
  "providerTurns",
] as const;
type CodeRewindProjection = ProjectionRecords<(typeof projectionFields)[number]>;

/**
 * The provider turn holding the uuid of the run's user message. A retried run
 * sent it once per attempt; the first one is before any of its edits.
 */
function firstUserMessageTurn(projection: CodeRewindProjection, runId: RunId) {
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

export const layer: Layer.Layer<
  ThreadCodeRewindServiceV2,
  never,
  ProjectionStoreV2 | ProviderSessionManagerV2 | RuntimePolicyV2
> = Layer.effect(
  ThreadCodeRewindServiceV2,
  Effect.gen(function* () {
    const projections = yield* ProjectionStoreV2;
    const sessions = yield* ProviderSessionManagerV2;
    const runtimePolicy = yield* RuntimePolicyV2;

    /** Asks the provider to restore (or preview) files to before the run's user message. */
    const rewindRun = Effect.fnUntraced(function* (
      projection: CodeRewindProjection,
      runId: RunId,
      dryRun: boolean,
    ) {
      const turn = firstUserMessageTurn(projection, runId);
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === turn?.providerThreadId,
      );
      if (
        turn?.nativeUserMessageId === undefined ||
        providerThread === undefined ||
        providerThread.providerSessionId === null
      ) {
        return null;
      }
      const modelSelection = projection.thread.modelSelection;
      const existingSession = projection.providerSessions.find(
        (candidate) => candidate.id === providerThread.providerSessionId,
      );
      const resolvedRuntimePolicy = yield* runtimePolicy.resolve({
        thread: projection.thread,
        modelSelection,
      });
      const session = yield* sessions.open({
        threadId: projection.thread.id,
        providerSessionId: providerThread.providerSessionId,
        modelSelection,
        runtimePolicy: resolvedRuntimePolicy,
        ...(existingSession === undefined ? {} : { resumeFromSession: existingSession }),
        ...(providerThread.nativeThreadRef?.nativeId == null
          ? {}
          : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
      });
      if (session.rewindFiles === undefined) return null;
      return yield* session.rewindFiles({
        providerThread,
        nativeUserMessageId: turn.nativeUserMessageId,
        dryRun,
        modelSelection,
        runtimePolicy: resolvedRuntimePolicy,
      });
    });

    const withUserError =
      (threadId: ThreadId) =>
      <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isThreadCodeRewindError(cause)
              ? cause
              : new ThreadCodeRewindError({
                  threadId,
                  detail: "Claude could not restore the code. Try again.",
                  cause,
                }),
          ),
        );

    const preview: ThreadCodeRewindServiceV2Shape["preview"] = (input) =>
      Effect.gen(function* () {
        const projection = yield* projections.getThreadRecords(input.threadId, projectionFields);
        const run = projection.runs.find(
          (candidate) => candidate.userMessageId === input.messageId,
        );
        const result: ProviderAdapterV2RewindFilesResult | null =
          run === undefined ? null : yield* rewindRun(projection, run.id, true);
        const nothing = { filesChanged: [], insertions: 0, deletions: 0 };
        if (result === null) return { ...nothing, unavailableReason: NO_FILE_SNAPSHOTS_MESSAGE };
        if (!result.canRewind) {
          return { ...nothing, unavailableReason: result.error ?? NO_FILE_SNAPSHOTS_MESSAGE };
        }
        return {
          filesChanged: result.filesChanged,
          insertions: result.insertions,
          deletions: result.deletions,
        };
      }).pipe(withUserError(input.threadId));

    const restore: ThreadCodeRewindServiceV2Shape["restore"] = (input) =>
      Effect.gen(function* () {
        const projection = yield* projections.getThreadRecords(input.threadId, projectionFields);
        const result = yield* rewindRun(projection, input.runId, false);
        if (result === null || !result.canRewind) {
          return yield* new ThreadCodeRewindError({
            threadId: input.threadId,
            detail: `Could not restore code: ${result?.error ?? NO_FILE_SNAPSHOTS_MESSAGE}`,
          });
        }
        return { skippedLinks: result.skippedLinks };
      }).pipe(withUserError(input.threadId));

    return ThreadCodeRewindServiceV2.of({ preview, restore });
  }),
);
