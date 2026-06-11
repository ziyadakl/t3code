/**
 * ProjectionThreadMessageRepository - Projection repository interface for messages.
 *
 * Owns persistence operations for projected thread messages rendered in the
 * orchestration read model.
 *
 * @module ProjectionThreadMessageRepository
 */
import {
  ChatAttachment,
  MessageId,
  OrchestrationMessageRole,
  ThreadId,
  TurnId,
  IsoDateTime,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Option from "effect/Option";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadMessage = Schema.Struct({
  messageId: MessageId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  // Claude provider message uuid — the conversation-rewind anchor. Nullable:
  // user messages, mid-turn assistant segments, and legacy rows have none.
  providerMessageUuid: Schema.optional(Schema.NullOr(Schema.String)),
  // Conversation-rewind "hide, don't delete" flag (ADR-0002). True once a
  // rewind marks this row as forward-of-the-anchor; the active timeline read
  // path filters these out while the row itself is retained. Optional/defaults
  // false for callers that never touch it.
  abandoned: Schema.optional(Schema.Boolean),
  isStreaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadMessage = typeof ProjectionThreadMessage.Type;

export const MarkProjectionThreadMessagesAbandonedInput = Schema.Struct({
  threadId: ThreadId,
  // Inclusive lower bound: every message at or after this creation timestamp is
  // marked abandoned (the rewound prompt and everything forward of it).
  fromCreatedAt: IsoDateTime,
});
export type MarkProjectionThreadMessagesAbandonedInput =
  typeof MarkProjectionThreadMessagesAbandonedInput.Type;

export const ListProjectionThreadMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadMessagesInput = typeof ListProjectionThreadMessagesInput.Type;

export const GetProjectionThreadMessageInput = Schema.Struct({
  messageId: MessageId,
});
export type GetProjectionThreadMessageInput = typeof GetProjectionThreadMessageInput.Type;

export const DeleteProjectionThreadMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadMessagesInput = typeof DeleteProjectionThreadMessagesInput.Type;

/**
 * ProjectionThreadMessageRepositoryShape - Service API for projected thread messages.
 */
export interface ProjectionThreadMessageRepositoryShape {
  /**
   * Insert or replace a projected thread message row.
   *
   * Upserts by `messageId`.
   */
  readonly upsert: (
    message: ProjectionThreadMessage,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected thread message by id.
   */
  readonly getByMessageId: (
    input: GetProjectionThreadMessageInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadMessage>, ProjectionRepositoryError>;

  /**
   * List projected thread messages for a thread.
   *
   * Returned in ascending creation order.
   */
  readonly listByThreadId: (
    input: ListProjectionThreadMessagesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadMessage>, ProjectionRepositoryError>;

  /**
   * Delete projected thread messages by thread.
   */
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadMessagesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Non-destructive conversation rewind (ADR-0002): flip `abandoned = 1` on
   * every message row at or after `fromCreatedAt` for a thread. Rows are never
   * deleted — the active timeline read path filters them, the event log /
   * transcript retain them. Returns the number of rows flipped.
   */
  readonly markAbandonedFromCreatedAt: (
    input: MarkProjectionThreadMessagesAbandonedInput,
  ) => Effect.Effect<number, ProjectionRepositoryError>;

  /**
   * Cancel an un-sent conversation rewind (ADR-0002): the exact inverse of
   * `markAbandonedFromCreatedAt` — flip `abandoned = 0` on every row at or after
   * `fromCreatedAt` that a prior rewind had hidden, so the timeline restores.
   * Returns the number of rows un-hidden.
   */
  readonly unmarkAbandonedFromCreatedAt: (
    input: MarkProjectionThreadMessagesAbandonedInput,
  ) => Effect.Effect<number, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadMessageRepository - Service tag for message projection persistence.
 */
export class ProjectionThreadMessageRepository extends Context.Service<
  ProjectionThreadMessageRepository,
  ProjectionThreadMessageRepositoryShape
>()("t3/persistence/Services/ProjectionThreadMessages/ProjectionThreadMessageRepository") {}
