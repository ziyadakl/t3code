import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
const createdAt = "2026-09-01T00:00:00.000Z";
const archivedAt = "2026-10-01T00:00:00.000Z";

layer("076_ProjectionProjectsPinArchive", (it) => {
  // The fork once added archived_at itself, after the numbered migrations. Databases it ran
  // on already have the column, so upstream's migration must not add it a second time.
  it.effect("keeps archive times in a database that already has archived_at", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 75 });
      yield* sql`ALTER TABLE projection_projects ADD COLUMN archived_at TEXT`;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at, archived_at
        ) VALUES
          ('archived-project', 'Archived', '/tmp/a', '[]', ${createdAt}, ${createdAt}, ${archivedAt}),
          ('open-project', 'Open', '/tmp/b', '[]', ${createdAt}, ${createdAt}, NULL)
      `;

      yield* runMigrations({ toMigrationInclusive: 76 });

      const columns = (yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `).map((column) => column.name);
      assert.strictEqual(columns.filter((name) => name === "archived_at").length, 1);
      assert.include(columns, "pinned_at");
      const rows = yield* sql<{
        readonly project_id: string;
        readonly archived_at: string | null;
        readonly pinned_at: string | null;
      }>`
        SELECT project_id, archived_at, pinned_at FROM projection_projects ORDER BY project_id
      `;
      assert.deepStrictEqual(
        rows.map((row) => [row.project_id, row.archived_at, row.pinned_at]),
        [
          ["archived-project", archivedAt, null],
          ["open-project", null, null],
        ],
      );
    }),
  );
});

const freshLayer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

freshLayer("076_ProjectionProjectsPinArchive on a database without archived_at", (it) => {
  it.effect("adds both columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 76 });
      const columns = (yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `).map((column) => column.name);
      assert.include(columns, "archived_at");
      assert.include(columns, "pinned_at");
    }),
  );
});
