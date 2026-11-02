import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Null means unpinned and not archived.
// Fork deviation: databases that ran our former project-archive column helper already have
// archived_at, so each column is added only when missing (see CUSTOM.md, "Dropped so far").
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_projects)`;
  const has = (name: string) => columns.some((column) => column.name === name);
  if (!has("pinned_at")) yield* sql`ALTER TABLE projection_projects ADD COLUMN pinned_at TEXT`;
  if (!has("archived_at")) yield* sql`ALTER TABLE projection_projects ADD COLUMN archived_at TEXT`;
});
