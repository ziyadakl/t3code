import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadArchiveQueries from "./ThreadArchiveQueries.ts";

// Threads are written through ProjectionStore.apply; the queries read the same database.
const layerSql = ThreadArchiveQueries.layer.pipe(
  Layer.provideMerge(ProjectionStore.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const now = DateTime.makeUnsafe("2026-09-04T12:00:00Z");
const old = DateTime.subtract(now, { days: 10 });
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "test-model" };

const createThread = Effect.fn(function* (
  name: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = ThreadId.make(`thread:settlement:${name}`);
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project:settlement"),
    title: name,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: old,
    updatedAt: old,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
  yield* store.apply({
    id: EventId.make(`event:${threadId}`),
    type: "thread.created",
    threadId,
    occurredAt: old,
    payload: thread,
  });
  return threadId;
});

const createRun = Effect.fn(function* (
  threadId: ThreadId,
  status: OrchestrationV2Run["status"] = "completed",
  ordinal = 1,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const runId = RunId.make(`run:${threadId}:${ordinal}`);
  yield* store.apply({
    id: EventId.make(`event:${runId}`),
    type: "run.created",
    threadId,
    occurredAt: old,
    payload: {
      id: runId,
      threadId,
      ordinal,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${runId}`),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: old,
      startedAt: status === "queued" ? null : old,
      completedAt: ["completed", "rolled_back", "failed"].includes(status) ? old : null,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
  return runId;
});

it.effect("sql: auto-archive candidates are settled threads and orphaned subagent children", () =>
  Effect.gen(function* () {
    const store = yield* ThreadArchiveQueries.ThreadArchiveQueries;
    const subagentOf = (parent: ThreadId) => ({
      lineage: {
        parentThreadId: parent,
        relationshipToParent: "subagent" as const,
        rootThreadId: parent,
      },
    });
    const settled = yield* createThread("archive-settled", {
      settledOverride: "settled",
      settledAt: old,
    });
    const busy = yield* createThread("archive-settled-busy", {
      settledOverride: "settled",
      settledAt: old,
    });
    yield* createRun(busy, "running");
    yield* createThread("archive-open");
    yield* createThread("archive-already", {
      settledOverride: "settled",
      settledAt: old,
      archivedAt: old,
    });
    const live = yield* createThread("archive-live-parent");
    const liveChild = yield* createThread("archive-live-child", subagentOf(live));
    const busyChild = yield* createThread("archive-busy-child", subagentOf(live));
    yield* createRun(busyChild, "running");
    const archivedParent = yield* createThread("archive-archived-parent", { archivedAt: old });
    const orphan = yield* createThread("archive-orphan", subagentOf(archivedParent));
    const archivedChild = yield* createThread("archive-archived-child", {
      ...subagentOf(archivedParent),
      archivedAt: old,
    });
    const deletedParent = yield* createThread("archive-deleted-parent", { deletedAt: old });
    const deletedOrphan = yield* createThread("archive-deleted-orphan", subagentOf(deletedParent));
    // A fork is not a helper: it outlives its parent.
    yield* createThread("archive-fork", {
      lineage: {
        parentThreadId: archivedParent,
        relationshipToParent: "fork",
        rootThreadId: archivedParent,
      },
    });

    const candidates = yield* store.getAutoArchiveCandidates();
    assert.deepEqual(
      new Map(
        candidates.map((thread) => [
          thread.id,
          [
            thread.orphaned,
            thread.busy,
            thread.settledSince === null ? null : DateTime.toEpochMillis(thread.settledSince),
          ],
        ]),
      ),
      new Map([
        [settled, [false, false, DateTime.toEpochMillis(old)]],
        [busy, [false, true, DateTime.toEpochMillis(old)]],
        [orphan, [true, false, null]],
        [deletedOrphan, [true, false, null]],
      ]),
    );

    assert.deepEqual(
      new Map(
        (yield* store.getSubagentChildren(archivedParent)).map((child) => [
          child.id,
          child.archivedAt === null,
        ]),
      ),
      new Map([
        [orphan, true],
        [archivedChild, false],
      ]),
    );
    assert.deepEqual(
      new Map((yield* store.getSubagentChildren(live)).map((child) => [child.id, child.busy])),
      new Map([
        [liveChild, false],
        [busyChild, true],
      ]),
    );
  }).pipe(Effect.provide(layerSql)),
);

// SQL only: the in-memory store has no scheduled tasks, so it never has one to skip.
it.effect("auto-archive skips threads an enabled scheduled task posts into", () =>
  Effect.gen(function* () {
    const store = yield* ThreadArchiveQueries.ThreadArchiveQueries;
    const sql = yield* SqlClient.SqlClient;
    const bindTask = (taskId: string, threadId: ThreadId, enabled: boolean) => sql`
      INSERT INTO scheduled_tasks (
        task_id, title, prompt, enabled, schedule_json, project_id, thread_id,
        workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
        created_by, creation_source, created_at, updated_at, last_run_status, run_count
      ) VALUES (
        ${taskId}, 'monthly', 'report', ${enabled ? 1 : 0}, '{}', 'project:settlement', ${threadId},
        '{}', '{}', 'full-access', 'default', 'user', 'web', '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z', 'never', 0
      )
    `;
    const settledScheduled = yield* createThread("scheduled-settled", {
      settledOverride: "settled",
      settledAt: old,
    });
    yield* bindTask("task:enabled", settledScheduled, true);
    const settledPaused = yield* createThread("scheduled-paused", {
      settledOverride: "settled",
      settledAt: old,
    });
    yield* bindTask("task:paused", settledPaused, false);
    const deletedParent = yield* createThread("scheduled-deleted-parent", { deletedAt: old });
    const orphanScheduled = yield* createThread("scheduled-orphan", {
      lineage: {
        parentThreadId: deletedParent,
        relationshipToParent: "subagent",
        rootThreadId: deletedParent,
      },
    });
    yield* bindTask("task:orphan", orphanScheduled, true);

    const candidates = yield* store.getAutoArchiveCandidates();
    assert.deepEqual(
      candidates.map((thread) => thread.id),
      [settledPaused],
    );
  }).pipe(Effect.provide(layerSql)),
);
