/**
 * The Claude side of message rewind. Fork feature (ADR 0003); `ClaudeAdapterV2.ts` keeps
 * one-line seams into this file. It imports that file's types only: values arrive as arguments.
 */
import type { OrchestrationV2ProviderTurn } from "@t3tools/contracts";
import type { ProviderDriverKind, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type {
  Query as ClaudeQuery,
  RewindFilesResult,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";

import type {
  ClaudeAgentSdkQueryOptions,
  ClaudeAgentSdkQueryRunnerError,
  ClaudeAgentSdkQueryRunnerShape,
  ClaudeAgentSdkQuerySession,
  makeClaudeQueryOptions,
} from "./ClaudeAdapterV2.ts";

/** Needs the query opened with `enableFileCheckpointing`. */
export type ClaudeQueryRewindFiles = (
  userMessageId: string,
  options: { readonly dryRun: boolean },
) => Effect.Effect<RewindFilesResult, ClaudeAgentSdkQueryRunnerError>;

/** The two frames a restore writes to the protocol log. */
export type ClaudeRewindProtocolLogEvent =
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "query.rewind_files";
        readonly userMessageId: string;
        readonly dryRun: boolean;
      };
    }
  | {
      readonly direction: "incoming";
      readonly stage: "decoded";
      readonly payload: { readonly type: "files.rewound" } & RewindFilesResult;
    };

/** Wraps the SDK query's `rewindFiles`: protocol logging and the refused-restore answer. */
export const wrapQueryRewindFiles =
  (
    queryRuntime: ClaudeQuery,
    logProtocolEvent: (event: ClaudeRewindProtocolLogEvent) => Effect.Effect<void>,
    queryRunnerError: (cause: unknown, method: string) => ClaudeAgentSdkQueryRunnerError,
  ): ClaudeQueryRewindFiles =>
  (userMessageId, options) =>
    logProtocolEvent({
      direction: "outgoing",
      stage: "decoded",
      payload: { type: "query.rewind_files", userMessageId, dryRun: options.dryRun },
    }).pipe(
      Effect.andThen(
        Effect.tryPromise({
          // A real restore the CLI refuses (for example "No file
          // checkpoint found for this message.") rejects, where a dry
          // run answers canRewind: false. Both answer the same way here.
          try: () =>
            queryRuntime
              .rewindFiles(userMessageId, { dryRun: options.dryRun })
              .catch((cause: unknown): RewindFilesResult => {
                if (
                  cause instanceof Error &&
                  Reflect.get(cause, "errorClass") === "control_request_failed"
                ) {
                  return { canRewind: false, error: cause.message };
                }
                throw cause;
              }),
          catch: (cause) => queryRunnerError(cause, "rewindFiles"),
        }),
      ),
      Effect.tap((result) =>
        logProtocolEvent({
          direction: "incoming",
          stage: "decoded",
          payload: { type: "files.rewound", ...result },
        }),
      ),
    );

/**
 * The runtime's `rewindFiles`. Claude keeps a session's file history in its
 * transcript. This thread's live process answers when there is one; otherwise a
 * process resumed only for the restore answers and is closed again.
 */
export const makeClaudeRewindFiles = (deps: {
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly queryRunner: ClaudeAgentSdkQueryRunnerShape;
  readonly liveQuery: Effect.Effect<{
    readonly nativeThreadId: string;
    readonly stopping: boolean;
    readonly query: ClaudeAgentSdkQuerySession;
  } | null>;
  readonly getNativeThreadId: (
    providerThread: ProviderAdapter.ProviderAdapterV2RewindFilesInput["providerThread"],
  ) => Effect.Effect<string, ProviderAdapter.ProviderAdapterProtocolError>;
  readonly makeQueryOptions: typeof makeClaudeQueryOptions;
  readonly settings: NonNullable<Parameters<typeof makeClaudeQueryOptions>[0]["settings"]>;
  readonly environment: NodeJS.ProcessEnv;
}) =>
  Effect.fn("ClaudeAdapterV2.rewindFiles")(
    function* (rewindInput: ProviderAdapter.ProviderAdapterV2RewindFilesInput) {
      const nativeThreadId = yield* deps.getNativeThreadId(rewindInput.providerThread);
      const rewind = (
        session: ClaudeAgentSdkQuerySession,
      ): Effect.Effect<
        RewindFilesResult,
        ProviderAdapter.ProviderAdapterProtocolError | ClaudeAgentSdkQueryRunnerError
      > =>
        session.rewindFiles === undefined
          ? Effect.fail(
              new ProviderAdapter.ProviderAdapterProtocolError({
                driver: deps.driver,
                detail: "This Claude query cannot restore files.",
              }),
            )
          : session.rewindFiles(rewindInput.nativeUserMessageId, {
              dryRun: rewindInput.dryRun,
            });
      const live = yield* deps.liveQuery;
      const result =
        live !== null && live.nativeThreadId === nativeThreadId && !live.stopping
          ? yield* rewind(live.query)
          : yield* Effect.acquireUseRelease(
              deps.queryRunner.open({
                threadId: deps.threadId,
                providerSessionId: deps.providerSessionId,
                options: {
                  ...deps.makeQueryOptions({
                    modelSelection: rewindInput.modelSelection,
                    nativeThreadId,
                    resume: true,
                    cwd: rewindInput.runtimePolicy.cwd,
                    settings: deps.settings,
                    environment: deps.environment,
                  }),
                  // This process only restores files. Loading the user's
                  // and project's settings runs their SessionStart hooks,
                  // and Claude withholds init until they finish: one
                  // project hook held a restore preview for 7.5 s.
                  settingSources: [],
                } satisfies ClaudeAgentSdkQueryOptions,
              }),
              rewind,
              (session) => session.close.pipe(Effect.ignore),
            );
      return {
        canRewind: result.canRewind,
        ...(result.error === undefined ? {} : { error: result.error }),
        filesChanged: result.filesChanged ?? [],
        insertions: result.insertions ?? 0,
        deletions: result.deletions ?? 0,
        skippedLinks: result.skippedLinks ?? 0,
      } satisfies ProviderAdapter.ProviderAdapterV2RewindFilesResult;
    },
    (effect, rewindInput) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterRewindFilesError({
              driver: deps.driver,
              providerThreadId: rewindInput.providerThread.id,
              cause,
            }),
        ),
      ),
  );

/** A turn's prompt echo and its prompt uuid: what a rewind restores files and resumes by. */
interface ClaudeRewindTurnContext {
  readonly promptUuid: string | null;
  nativeUserMessageId: string | null;
}

/** The provider-turn fields that name the prompt, recorded from the turn's start. */
export const claudeTurnRewindFields = (context: ClaudeRewindTurnContext) => ({
  ...(context.nativeUserMessageId === null
    ? {}
    : { nativeUserMessageId: context.nativeUserMessageId }),
  // Recorded from the start, so a turn stopped before Claude echoes
  // its prompt can still be rewound.
  ...(context.promptUuid === null ? {} : { nativePromptId: context.promptUuid }),
});

/**
 * A prompt's replay echo is bookkeeping, not conversation. The first one of a
 * prompted turn names the uuid its files are checkpointed by; nothing else reads
 * these frames. Returns true when the frame was one.
 */
export const recordClaudePromptEcho = (
  context: ClaudeRewindTurnContext | null,
  message: SDKMessage,
): boolean => {
  if (message.type !== "user" || !("isReplay" in message) || message.isReplay !== true) {
    return false;
  }
  if (context?.promptUuid != null && context.nativeUserMessageId === null) {
    context.nativeUserMessageId = message.uuid;
  }
  return true;
};

/** Where a rollback to the start of the thread resumes: the rewind's point, else the fork head. */
export const claudeThreadStartResumeAt = (
  input: ProviderAdapter.ProviderAdapterV2RollbackThreadInput,
): string | null =>
  (input.target.type === "thread_start" ? input.target.nativeResumeAt : undefined) ??
  input.providerThread.nativeMetadata?.forkHeadMessageId ??
  null;

/**
 * A turn that ended before Claude replied (stopped, failed) recorded no
 * assistant uuid. Prompt uuids are random, so the session resumes just after the
 * prompt uuid its provider turn recorded. Null when the turn recorded none and
 * has no attempt to derive one from.
 */
export const claudePromptResumeAt = Effect.fn("claudePromptResumeAt")(function* (
  providerTurn: OrchestrationV2ProviderTurn,
) {
  const promptId = providerTurn.nativeUserMessageId ?? providerTurn.nativePromptId;
  if (promptId !== undefined) {
    return promptId;
  }
  // Turns from builds that recorded no prompt uuid sent one derived from
  // the attempt.
  if (providerTurn.runAttemptId !== null) {
    return yield* legacyClaudePromptUuid(providerTurn.runAttemptId);
  }
  return null;
});

// Legacy only: the prompt uuid builds before random prompt ids derived from
// the run attempt. New turns record the uuid they actually send.
const legacyClaudePromptUuid = Effect.fn("legacyClaudePromptUuid")(function* (attemptId: string) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(`t3-claude-prompt:${attemptId}`))
    .pipe(Effect.orDie);
  const hex = Hex.encode(digest);
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
});
