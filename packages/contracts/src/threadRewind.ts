/**
 * Claude Code style rewind (`thread.rewind`). Fork feature (ADR 0003). Imports only
 * `baseSchemas`, so `orchestrationV2.ts` imports it without a cycle and re-exports it.
 */
import * as Schema from "effect/Schema";

import {
  CommandId,
  MessageId,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * The choices of Claude Code's `/rewind` menu, in its order. Its last choice,
 * "Never mind", changes nothing and never reaches the server.
 */
export const ThreadRewindChoice = Schema.Literals([
  "code-and-conversation",
  "conversation",
  "code",
  "summarize-from",
  "summarize-up-to",
]);
export type ThreadRewindChoice = typeof ThreadRewindChoice.Type;
export const THREAD_REWIND_CHOICES = ThreadRewindChoice.literals;

const THREAD_REWIND_RESTORES: Record<
  ThreadRewindChoice,
  { readonly code: boolean; readonly conversation: boolean } | null
> = {
  "code-and-conversation": { code: true, conversation: true },
  conversation: { code: false, conversation: true },
  code: { code: true, conversation: false },
  // Summarizing waits on a supported Claude mechanism (ticket #41).
  "summarize-from": null,
  "summarize-up-to": null,
};

/** What `choice` puts back, or null when T3 Code cannot carry it out yet. */
export function threadRewindRestores(
  choice: ThreadRewindChoice,
): { readonly code: boolean; readonly conversation: boolean } | null {
  return THREAD_REWIND_RESTORES[choice];
}

/** Whether the rewound message's prompt goes back into the composer after `choice`. */
export function threadRewindRestoresPrompt(choice: ThreadRewindChoice): boolean {
  return (
    choice === "code-and-conversation" || choice === "conversation" || choice === "summarize-from"
  );
}

/**
 * Claude Code style rewind to just before a sent user message. The server
 * decides whether the choice is possible for that message and refuses
 * otherwise; clients only offer what it allows.
 */
export const ThreadRewindCommand = Schema.Struct({
  type: Schema.Literal("thread.rewind"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  choice: ThreadRewindChoice,
  /** Extra guidance for the summary; only the summarize choices use it. */
  instructions: Schema.optional(TrimmedNonEmptyString),
});

/**
 * Opens a session record for an imported chat that holds only its native
 * history, as its first turn would, so the provider can answer for it (for
 * example a code restore preview). A no-op once the chat has one.
 */
export const ImportedSessionBindCommand = Schema.Struct({
  type: Schema.Literal("provider-thread.imported-session.bind"),
  commandId: CommandId,
  threadId: ThreadId,
});

/** Records that the rewind `requestId` finished, with an optional notice for the user. */
export const CheckpointRollbackCompleteCommand = Schema.Struct({
  type: Schema.Literal("checkpoint.rollback.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: CommandId,
  notice: Schema.optional(TrimmedNonEmptyString),
});

/**
 * Latest rewind that finished, with what the user should know about it (for
 * example files a code restore left alone). A thread carries it as
 * `rollbackCompletion`; the next rollback clears it.
 */
export const RollbackCompletion = Schema.Struct({
  requestId: CommandId,
  notice: Schema.optional(TrimmedNonEmptyString),
});

/** Fields rewind adds to a provider turn; spread into `OrchestrationV2ProviderTurn`. */
export const ProviderTurnRewindFields = {
  /**
   * The provider's id for the user message that started this turn. Claude
   * restores files to their state before that message by this id.
   */
  nativeUserMessageId: Schema.optional(TrimmedNonEmptyString),
  /**
   * Claude: the uuid this turn's prompt was sent with, recorded when the turn
   * starts. Rewinding the conversation can resume after it even when the turn
   * stopped before Claude echoed it. Not a file snapshot key: only an echoed
   * prompt (nativeUserMessageId) has one.
   */
  nativePromptId: Schema.optional(TrimmedNonEmptyString),
  /**
   * Imported Claude turns only, when the prompt is not its transcript's
   * first: where the session resumes to keep the transcript before the
   * prompt, a turn id or a user message id. A rewind to before this turn
   * resumes there instead of starting the session over.
   */
  nativeResumeAt: Schema.optional(TrimmedNonEmptyString),
};

export const OrchestrationV2PreviewThreadRewindInput = Schema.Struct({
  threadId: ThreadId,
  /** A sent user message; the preview is of restoring code to just before it. */
  messageId: MessageId,
});
export type OrchestrationV2PreviewThreadRewindInput =
  typeof OrchestrationV2PreviewThreadRewindInput.Type;

/** What the rewind menu's code choices would change for one message (a dry run). */
export const OrchestrationV2ThreadRewindPreview = Schema.Struct({
  filesChanged: Schema.Array(Schema.String),
  insertions: NonNegativeInt,
  deletions: NonNegativeInt,
  /** Why code cannot be restored to before this message, for the menu to say. */
  unavailableReason: Schema.optional(Schema.String),
});
export type OrchestrationV2ThreadRewindPreview = typeof OrchestrationV2ThreadRewindPreview.Type;

/** The code choices show only when restoring would change a file. */
export function threadRewindPreviewOffersCode(
  preview: OrchestrationV2ThreadRewindPreview,
): boolean {
  return preview.filesChanged.length > 0;
}

export class OrchestrationPreviewThreadRewindError extends Schema.TaggedError<OrchestrationPreviewThreadRewindError>()(
  "OrchestrationPreviewThreadRewindError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** The `previewThreadRewind` entry of `OrchestrationV2RpcSchemas`. */
export const ThreadRewindPreviewRpcSchema = {
  input: OrchestrationV2PreviewThreadRewindInput,
  output: OrchestrationV2ThreadRewindPreview,
};
