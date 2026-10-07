import {
  CommandId,
  type MessageId,
  type OrchestrationV2ThreadRewindPreview,
  type ProviderSessionId,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Orchestrator from "./Orchestrator.ts";
import { ProjectionStoreV2, type ProjectionRecords } from "./ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";
import { NO_FILE_SNAPSHOTS_MESSAGE, runFileCheckpointTurn } from "./ThreadRewindTargets.ts";

export class ThreadCodeRewindError extends Schema.TaggedError<ThreadCodeRewindError>()(
  "ThreadCodeRewindError",
  {
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Claude could not restore the code. Try again.";
  }
}

const NO_CODE_CHANGES_MESSAGE =
  "Claude changed no files after this message, so there is no code to restore.";

/** The notice for a restore that left files alone, or null when it restored all. */
export function skippedFilesMessage(skippedLinks: number): string | null {
  if (skippedLinks === 0) return null;
  return skippedLinks === 1
    ? "Code restored, but 1 file was left as it is: a link made it unsafe to write."
    : `Code restored, but ${skippedLinks} files were left as they are: a link made them unsafe to write.`;
}

export class ThreadCodeRewindServiceV2 extends Context.Service<
  ThreadCodeRewindServiceV2,
  {
    /** What "Restore code" would change for a sent message. No files: the code choices stay hidden. */
    readonly preview: (input: {
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
    }) => Effect.Effect<OrchestrationV2ThreadRewindPreview, ThreadCodeRewindError>;
    /**
     * Puts files back as they were before the user message that started
     * `runId`, once a dry run shows it would change some. Claude refusing, or
     * having nothing to restore, is an answer, not an error: retrying cannot help.
     */
    readonly restore: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
    }) => Effect.Effect<
      | { readonly restored: true; readonly skippedLinks: number }
      | { readonly restored: false; readonly reason: string },
      ThreadCodeRewindError
    >;
  }
>()("t3/orchestration-v2/ThreadCodeRewindService/ThreadCodeRewindServiceV2") {}

const projectionFields = [
  "providerThreads",
  "providerSessions",
  "runs",
  "attempts",
  "providerTurns",
] as const;

/**
 * Opens the provider session that holds `providerThread`, as its next turn
 * would, for a call made between turns (a rollback, a file restore).
 */
export const openProviderThreadSession = Effect.fnUntraced(function* (
  services: {
    readonly sessions: ProviderSessionManagerV2["Service"];
    readonly runtimePolicy: RuntimePolicyV2["Service"];
  },
  input: {
    readonly projection: ProjectionRecords<"providerSessions">;
    readonly providerThread: ProjectionRecords<"providerThreads">["providerThreads"][number];
    readonly providerSessionId: ProviderSessionId;
  },
) {
  const { projection, providerThread } = input;
  const modelSelection = projection.thread.modelSelection;
  const runtimePolicy = yield* services.runtimePolicy.resolve({
    thread: projection.thread,
    modelSelection,
  });
  const existingSession = projection.providerSessions.find(
    (candidate) => candidate.id === input.providerSessionId,
  );
  const session = yield* services.sessions.open({
    threadId: projection.thread.id,
    providerSessionId: input.providerSessionId,
    modelSelection,
    runtimePolicy,
    ...(existingSession === undefined ? {} : { resumeFromSession: existingSession }),
    ...(providerThread.nativeThreadRef?.nativeId == null
      ? {}
      : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
    ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
      ? {}
      : { initialProviderItemIdentityVersion: providerThread.nativeMetadata.itemIdentityVersion }),
  });
  return { session, modelSelection, runtimePolicy };
});

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStoreV2;
  const sessions = yield* ProviderSessionManagerV2;
  const runtimePolicy = yield* RuntimePolicyV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;

  const readProjection = (threadId: ThreadId) =>
    projections.getThreadRecords(threadId, projectionFields);

  /**
   * Asks the provider to restore (or preview) files to before the run's user
   * message. Null: no provider session can answer for it.
   */
  const rewindRun = Effect.fnUntraced(function* (
    projection: ProjectionRecords<(typeof projectionFields)[number]>,
    runId: RunId,
    dryRun: boolean,
  ) {
    const turn = runFileCheckpointTurn(projection, runId);
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
    const opened = yield* openProviderThreadSession(
      { sessions, runtimePolicy },
      { projection, providerThread, providerSessionId: providerThread.providerSessionId },
    );
    if (opened.session.rewindFiles === undefined) return null;
    return yield* opened.session.rewindFiles({
      providerThread,
      nativeUserMessageId: turn.nativeUserMessageId,
      dryRun,
      modelSelection: opened.modelSelection,
      runtimePolicy: opened.runtimePolicy,
    });
  });

  const withRewindError =
    (threadId: ThreadId) =>
    <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.mapError((cause) => new ThreadCodeRewindError({ threadId, cause })));

  const preview: ThreadCodeRewindServiceV2["Service"]["preview"] = (input) =>
    Effect.gen(function* () {
      let projection = yield* readProjection(input.threadId);
      const run = projection.runs.find((candidate) => candidate.userMessageId === input.messageId);
      const nothing = { filesChanged: [], insertions: 0, deletions: 0 };
      if (run === undefined) return { ...nothing, unavailableReason: NO_FILE_SNAPSHOTS_MESSAGE };
      // An imported chat T3 Code has not continued yet opens its session
      // first, as rewinding it would.
      const providerThreadId = runFileCheckpointTurn(projection, run.id)?.providerThreadId;
      if (
        projection.providerThreads.find((candidate) => candidate.id === providerThreadId)
          ?.providerSessionId === null
      ) {
        yield* orchestrator.dispatch({
          type: "provider-thread.imported-session.bind",
          commandId: CommandId.make(`imported-session-bind:${input.threadId}`),
          threadId: input.threadId,
        });
        projection = yield* readProjection(input.threadId);
      }
      const result = yield* rewindRun(projection, run.id, true);
      if (result === null) return { ...nothing, unavailableReason: NO_FILE_SNAPSHOTS_MESSAGE };
      if (!result.canRewind) {
        return { ...nothing, unavailableReason: result.error ?? NO_FILE_SNAPSHOTS_MESSAGE };
      }
      return {
        filesChanged: result.filesChanged,
        insertions: result.insertions,
        deletions: result.deletions,
      };
    }).pipe(withRewindError(input.threadId));

  const restore: ThreadCodeRewindServiceV2["Service"]["restore"] = (input) =>
    Effect.gen(function* () {
      const projection = yield* readProjection(input.threadId);
      const refused = (reason: string) => ({
        restored: false as const,
        reason: `Could not restore code: ${reason}`,
      });
      // A dry run first, so a restore that would change nothing is refused
      // before any file is touched.
      const dryRun = yield* rewindRun(projection, input.runId, true);
      if (dryRun === null || !dryRun.canRewind) {
        return refused(dryRun?.error ?? NO_FILE_SNAPSHOTS_MESSAGE);
      }
      if (dryRun.filesChanged.length === 0) return refused(NO_CODE_CHANGES_MESSAGE);
      const result = yield* rewindRun(projection, input.runId, false);
      if (result === null || !result.canRewind) {
        return refused(result?.error ?? NO_FILE_SNAPSHOTS_MESSAGE);
      }
      return { restored: true as const, skippedLinks: result.skippedLinks };
    }).pipe(withRewindError(input.threadId));

  return ThreadCodeRewindServiceV2.of({ preview, restore });
});

export const layer = Layer.effect(ThreadCodeRewindServiceV2, make);
