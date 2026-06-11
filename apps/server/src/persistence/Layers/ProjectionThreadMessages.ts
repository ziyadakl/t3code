import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { ChatAttachment } from "@t3tools/contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionThreadMessageInput,
  MarkProjectionThreadMessagesAbandonedInput,
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessageRepositoryShape,
  DeleteProjectionThreadMessagesInput,
  ListProjectionThreadMessagesInput,
  ProjectionThreadMessage,
} from "../Services/ProjectionThreadMessages.ts";

const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
    providerMessageUuid: Schema.NullOr(Schema.String),
    abandoned: Schema.Number,
  }),
);

const MarkedMessageIdRowSchema = Schema.Struct({ messageId: Schema.String });

function toProjectionThreadMessage(
  row: Schema.Schema.Type<typeof ProjectionThreadMessageDbRowSchema>,
): ProjectionThreadMessage {
  return {
    messageId: row.messageId,
    threadId: row.threadId,
    turnId: row.turnId,
    role: row.role,
    text: row.text,
    isStreaming: row.isStreaming === 1,
    abandoned: row.abandoned === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.attachments !== null ? { attachments: row.attachments } : {}),
    ...(row.providerMessageUuid !== null
      ? { providerMessageUuid: row.providerMessageUuid }
      : {}),
  };
}

const makeProjectionThreadMessageRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadMessageRow = SqlSchema.void({
    Request: ProjectionThreadMessage,
    execute: (row) => {
      const nextAttachmentsJson =
        row.attachments !== undefined ? JSON.stringify(row.attachments) : null;
      // Nullable anchor uuid. The streaming `assistant.delta` writes this row
      // first with a null uuid; the later `assistant.complete` carries the real
      // (turn-final) uuid. COALESCE makes a non-null value win and never lets a
      // subsequent null overwrite it — mirroring attachments_json above so the
      // last non-null = the rewind anchor.
      const nextProviderMessageUuid =
        row.providerMessageUuid !== undefined ? row.providerMessageUuid : null;
      // Conversation-rewind flag is owned by the dedicated mark/UPDATE path, not
      // by upserts. A normal upsert must never clear an already-set abandoned
      // flag (e.g. a late streaming delta on a rewound row), so preserve the
      // existing value on conflict and default new rows to 0.
      const nextAbandoned = row.abandoned === true ? 1 : null;
      return sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          provider_message_uuid,
          abandoned,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          ${row.messageId},
          ${row.threadId},
          ${row.turnId},
          ${row.role},
          ${row.text},
          COALESCE(
            ${nextAttachmentsJson},
            (
              SELECT attachments_json
              FROM projection_thread_messages
              WHERE message_id = ${row.messageId}
            )
          ),
          COALESCE(
            ${nextProviderMessageUuid},
            (
              SELECT provider_message_uuid
              FROM projection_thread_messages
              WHERE message_id = ${row.messageId}
            )
          ),
          COALESCE(
            ${nextAbandoned},
            (
              SELECT abandoned
              FROM projection_thread_messages
              WHERE message_id = ${row.messageId}
            ),
            0
          ),
          ${row.isStreaming ? 1 : 0},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (message_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          role = excluded.role,
          text = excluded.text,
          attachments_json = COALESCE(
            excluded.attachments_json,
            projection_thread_messages.attachments_json
          ),
          provider_message_uuid = COALESCE(
            excluded.provider_message_uuid,
            projection_thread_messages.provider_message_uuid
          ),
          abandoned = COALESCE(
            ${nextAbandoned},
            projection_thread_messages.abandoned
          ),
          is_streaming = excluded.is_streaming,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `;
    },
  });

  const getProjectionThreadMessageRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadMessageInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ messageId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          provider_message_uuid AS "providerMessageUuid",
          abandoned,
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE message_id = ${messageId}
        LIMIT 1
      `,
  });

  const listProjectionThreadMessageRows = SqlSchema.findAll({
    Request: ListProjectionThreadMessagesInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          provider_message_uuid AS "providerMessageUuid",
          abandoned,
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const deleteProjectionThreadMessageRows = SqlSchema.void({
    Request: DeleteProjectionThreadMessagesInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_messages
        WHERE thread_id = ${threadId}
      `,
  });

  // Non-destructive rewind: flip the flag in place and RETURN the flipped ids so
  // callers get an accurate count. Already-abandoned rows are excluded so a
  // repeated rewind to the same point reports 0 newly hidden rows.
  const markProjectionThreadMessageRowsAbandoned = SqlSchema.findAll({
    Request: MarkProjectionThreadMessagesAbandonedInput,
    Result: MarkedMessageIdRowSchema,
    execute: ({ threadId, fromCreatedAt }) =>
      sql`
        UPDATE projection_thread_messages
        SET abandoned = 1
        WHERE thread_id = ${threadId}
          AND abandoned = 0
          AND created_at >= ${fromCreatedAt}
        RETURNING message_id AS "messageId"
      `,
  });

  // Cancel an un-sent rewind: the exact inverse of the abandon flip above.
  // Un-hide rows that a rewind had marked abandoned at/after the anchor.
  const unmarkProjectionThreadMessageRowsAbandoned = SqlSchema.findAll({
    Request: MarkProjectionThreadMessagesAbandonedInput,
    Result: MarkedMessageIdRowSchema,
    execute: ({ threadId, fromCreatedAt }) =>
      sql`
        UPDATE projection_thread_messages
        SET abandoned = 0
        WHERE thread_id = ${threadId}
          AND abandoned = 1
          AND created_at >= ${fromCreatedAt}
        RETURNING message_id AS "messageId"
      `,
  });

  const upsert: ProjectionThreadMessageRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadMessageRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadMessageRepository.upsert:query")),
    );

  const getByMessageId: ProjectionThreadMessageRepositoryShape["getByMessageId"] = (input) =>
    getProjectionThreadMessageRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.getByMessageId:query"),
      ),
      Effect.map(Option.map(toProjectionThreadMessage)),
    );

  const listByThreadId: ProjectionThreadMessageRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.listByThreadId:query"),
      ),
      Effect.map((rows) => rows.map(toProjectionThreadMessage)),
    );

  const deleteByThreadId: ProjectionThreadMessageRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.deleteByThreadId:query"),
      ),
    );

  const markAbandonedFromCreatedAt: ProjectionThreadMessageRepositoryShape["markAbandonedFromCreatedAt"] =
    (input) =>
      markProjectionThreadMessageRowsAbandoned(input).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionThreadMessageRepository.markAbandonedFromCreatedAt:query",
          ),
        ),
        Effect.map((rows) => rows.length),
      );

  const unmarkAbandonedFromCreatedAt: ProjectionThreadMessageRepositoryShape["unmarkAbandonedFromCreatedAt"] =
    (input) =>
      unmarkProjectionThreadMessageRowsAbandoned(input).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionThreadMessageRepository.unmarkAbandonedFromCreatedAt:query",
          ),
        ),
        Effect.map((rows) => rows.length),
      );

  return {
    upsert,
    getByMessageId,
    listByThreadId,
    deleteByThreadId,
    markAbandonedFromCreatedAt,
    unmarkAbandonedFromCreatedAt,
  } satisfies ProjectionThreadMessageRepositoryShape;
});

export const ProjectionThreadMessageRepositoryLive = Layer.effect(
  ProjectionThreadMessageRepository,
  makeProjectionThreadMessageRepository,
);
