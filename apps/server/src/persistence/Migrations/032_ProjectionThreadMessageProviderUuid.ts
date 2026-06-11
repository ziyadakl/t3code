/**
 * Conversation-rewind data layer (Phase 0).
 *
 * Adds the columns the non-destructive rewind feature anchors on, all
 * backward-safe and idempotent (the Migration 027 `PRAGMA table_info` pattern):
 *
 * - `projection_thread_messages.provider_message_uuid TEXT` (nullable, +index):
 *   the Claude message `uuid` for an assistant message. Rewind resolves "jump
 *   back to this prompt" to the provider uuid of the assistant message just
 *   before it, then resumes the SDK session "up to and including" that uuid.
 *   Nullable on purpose: legacy rows, user messages, and mid-turn assistant
 *   segments have no anchor uuid and decode as NULL.
 *
 * - `projection_thread_messages.abandoned INTEGER NOT NULL DEFAULT 0` and
 *   `projection_turns.abandoned INTEGER NOT NULL DEFAULT 0` (+indexes): the
 *   "hide, don't delete" flag a later stream (WS-2) flips so the active
 *   timeline drops the skipped-forward rows while the event log / transcript
 *   retain them. Phase 0 only ADDS the column with a safe default; the
 *   read-path filter and the write that sets it are WS-2's.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const messageColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;
  if (!messageColumns.some((column) => column.name === "provider_message_uuid")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN provider_message_uuid TEXT
    `;
  }
  if (!messageColumns.some((column) => column.name === "abandoned")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN abandoned INTEGER NOT NULL DEFAULT 0
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_provider_uuid
    ON projection_thread_messages(provider_message_uuid)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_abandoned
    ON projection_thread_messages(thread_id, abandoned)
  `;

  const turnColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_turns)
  `;
  if (!turnColumns.some((column) => column.name === "abandoned")) {
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN abandoned INTEGER NOT NULL DEFAULT 0
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_thread_abandoned
    ON projection_turns(thread_id, abandoned)
  `;
});
