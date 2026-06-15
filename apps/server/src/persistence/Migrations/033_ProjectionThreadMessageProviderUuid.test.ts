import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("033_ProjectionThreadMessageProviderUuid", (it) => {
  it.effect(
    "adds provider_message_uuid + abandoned columns; existing rows get NULL / 0; re-run is idempotent",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        // Migrate up to just before 033, then seed pre-existing rows.
        yield* runMigrations({ toMigrationInclusive: 32 });

        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id,
            thread_id,
            turn_id,
            role,
            text,
            is_streaming,
            created_at,
            updated_at
          )
          VALUES (
            'msg-legacy',
            'thread-legacy',
            NULL,
            'assistant',
            'legacy text',
            0,
            '2026-05-29T00:00:00.000Z',
            '2026-05-29T00:00:00.000Z'
          )
        `;
        yield* sql`
          INSERT INTO projection_turns (
            thread_id,
            turn_id,
            state,
            requested_at,
            checkpoint_files_json
          )
          VALUES (
            'thread-legacy',
            'turn-legacy',
            'completed',
            '2026-05-29T00:00:00.000Z',
            '[]'
          )
        `;

        yield* runMigrations({ toMigrationInclusive: 33 });

        const messageColumns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(projection_thread_messages)
        `;
        const turnColumns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(projection_turns)
        `;

        assert.isTrue(messageColumns.some((c) => c.name === "provider_message_uuid"));
        assert.isTrue(messageColumns.some((c) => c.name === "abandoned"));
        assert.isTrue(turnColumns.some((c) => c.name === "abandoned"));

        // Existing rows: uuid NULL, abandoned defaulted to 0.
        const messageRow = yield* sql<{
          readonly providerMessageUuid: string | null;
          readonly abandoned: number;
        }>`
          SELECT
            provider_message_uuid AS "providerMessageUuid",
            abandoned
          FROM projection_thread_messages
          WHERE message_id = 'msg-legacy'
        `;
        assert.equal(messageRow[0]?.providerMessageUuid, null);
        assert.equal(messageRow[0]?.abandoned, 0);

        const turnRow = yield* sql<{ readonly abandoned: number }>`
          SELECT abandoned FROM projection_turns WHERE turn_id = 'turn-legacy'
        `;
        assert.equal(turnRow[0]?.abandoned, 0);

        // Re-running the migration is a no-op (idempotent guards): schema and
        // existing rows are unchanged.
        yield* runMigrations({ toMigrationInclusive: 33 });

        const messageColumnsAfter = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(projection_thread_messages)
        `;
        assert.deepStrictEqual(
          messageColumnsAfter.map((c) => c.name),
          messageColumns.map((c) => c.name),
        );

        const messageRowAfter = yield* sql<{
          readonly providerMessageUuid: string | null;
          readonly abandoned: number;
        }>`
          SELECT
            provider_message_uuid AS "providerMessageUuid",
            abandoned
          FROM projection_thread_messages
          WHERE message_id = 'msg-legacy'
        `;
        assert.equal(messageRowAfter[0]?.providerMessageUuid, null);
        assert.equal(messageRowAfter[0]?.abandoned, 0);
      }),
  );
});
