import {
  OrchestrationV2AppThreadJson,
  type OrchestrationV2AppThread,
  type ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

import { ProjectionStoreSetupError, type ProjectionStoreV2Error } from "./ProjectionStore.ts";

const decodeThreadPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);

/**
 * An unarchived thread the auto-archive sweep may archive: one that is settled,
 * or a subagent child whose parent is archived, deleted or missing. A thread an
 * enabled scheduled task posts into is never a candidate.
 */
export type ProjectionAutoArchiveCandidate = Pick<OrchestrationV2AppThread, "id" | "updatedAt"> & {
  readonly pinnedAt: DateTime.Utc | null;
  readonly snoozedUntil: DateTime.Utc | null;
  /** When the user settled it; null unless it is settled. */
  readonly settledSince: DateTime.Utc | null;
  /** Subagent child whose parent is archived, deleted or missing. */
  readonly orphaned: boolean;
  /** Has a live run or a pending runtime request. */
  readonly busy: boolean;
};

export type ProjectionSubagentChild = Pick<OrchestrationV2AppThread, "id" | "archivedAt"> & {
  /** Has a live run or a pending runtime request, as for an auto-archive candidate. */
  readonly busy: boolean;
};

export interface ThreadArchiveQueriesShape {
  readonly getAutoArchiveCandidates: () => Effect.Effect<
    ReadonlyArray<ProjectionAutoArchiveCandidate>,
    ProjectionStoreV2Error
  >;
  /** Subagent children of `threadId` that are not deleted, archived or not. */
  readonly getSubagentChildren: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ProjectionSubagentChild>, ProjectionStoreV2Error>;
}

/** The read queries the auto-archive sweep and the archive cascade run on the projection. */
export class ThreadArchiveQueries extends Context.Service<
  ThreadArchiveQueries,
  ThreadArchiveQueriesShape
>()("t3/orchestration-v2/ThreadArchiveQueries") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A thread the archive sweep leaves alone: a live run or a pending runtime request.
  const isBusyThread = (threadId: Statement.Fragment) => sql`
      (
        EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runs active
          WHERE active.thread_id = ${threadId}
            AND active.status IN ('preparing', 'starting', 'running', 'waiting')
        )
        OR EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runtime_requests request
          WHERE request.thread_id = ${threadId} AND request.status = 'pending'
        )
      )
    `;

  const getAutoArchiveCandidates: ThreadArchiveQueriesShape["getAutoArchiveCandidates"] = Effect.fn(
    "ThreadArchiveQueries.getAutoArchiveCandidates",
  )(
    function* () {
      const rows = yield* sql<{
        readonly payload_json: string;
        readonly orphaned: number;
        readonly busy: number;
      }>`
          SELECT candidate.payload_json, candidate.orphaned,
            ${isBusyThread(sql`candidate.thread_id`)} AS busy
          FROM (
            SELECT t.thread_id, t.payload_json, t.updated_at,
              (
                json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
                AND (
                  parent.thread_id IS NULL
                  OR parent.deleted_at IS NOT NULL
                  OR json_extract(parent.payload_json, '$.archivedAt') IS NOT NULL
                )
              ) AS orphaned
            FROM orchestration_v2_projection_threads t
            LEFT JOIN orchestration_v2_projection_threads parent
              ON parent.thread_id = json_extract(t.payload_json, '$.lineage.parentThreadId')
            WHERE t.deleted_at IS NULL
              AND json_extract(t.payload_json, '$.archivedAt') IS NULL
          ) candidate
          WHERE (
              candidate.orphaned
              OR (
                json_extract(candidate.payload_json, '$.settledOverride') = 'settled'
                AND json_extract(candidate.payload_json, '$.settledAt') IS NOT NULL
              )
            )
            -- Archived, it would refuse every later run of the task.
            AND NOT EXISTS (
              SELECT 1 FROM scheduled_tasks task
              WHERE task.thread_id = candidate.thread_id AND task.enabled = 1
            )
          ORDER BY candidate.updated_at ASC, candidate.thread_id ASC
        `;
      return yield* Effect.forEach(rows, (row) =>
        decodeThreadPayload(row.payload_json).pipe(
          Effect.map((thread): ProjectionAutoArchiveCandidate => ({
            id: thread.id,
            settledSince: thread.settledOverride === "settled" ? thread.settledAt : null,
            updatedAt: thread.updatedAt,
            pinnedAt: thread.pinnedAt ?? null,
            snoozedUntil: thread.snoozedUntil ?? null,
            orphaned: row.orphaned === 1,
            busy: row.busy === 1,
          })),
        ),
      );
    },
    Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
    NodeSqliteClient.readOnly,
  );

  const getSubagentChildren: ThreadArchiveQueriesShape["getSubagentChildren"] = Effect.fn(
    "ThreadArchiveQueries.getSubagentChildren",
  )(
    function* (threadId: ThreadId) {
      const rows = yield* sql<{ readonly payload_json: string; readonly busy: number }>`
          SELECT child.payload_json, ${isBusyThread(sql`child.thread_id`)} AS busy
          FROM orchestration_v2_projection_threads child
          WHERE child.deleted_at IS NULL
            AND json_extract(child.payload_json, '$.lineage.parentThreadId') = ${threadId}
            AND json_extract(child.payload_json, '$.lineage.relationshipToParent') = 'subagent'
          ORDER BY child.created_at ASC, child.thread_id ASC
        `;
      return yield* Effect.forEach(rows, (row) =>
        decodeThreadPayload(row.payload_json).pipe(
          Effect.map((thread): ProjectionSubagentChild => ({
            id: thread.id,
            archivedAt: thread.archivedAt,
            busy: row.busy === 1,
          })),
        ),
      );
    },
    Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
    NodeSqliteClient.readOnly,
  );

  return { getAutoArchiveCandidates, getSubagentChildren } satisfies ThreadArchiveQueriesShape;
});

export const layer = Layer.effect(ThreadArchiveQueries, make);
