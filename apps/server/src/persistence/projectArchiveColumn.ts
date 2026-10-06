import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Adds `projection_projects.archived_at` when missing. It runs after the
 * numbered migrations instead of taking a migration id, because this column
 * is carried outside upstream and a borrowed id would collide with a later
 * upstream migration (the migrator keys on id and skips the newcomer).
 */
export const ensureProjectArchiveColumn = Effect.fn("ensureProjectArchiveColumn")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  if (columns.length === 0 || columns.some((column) => column.name === "archived_at")) return;
  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN archived_at TEXT
  `;
});
