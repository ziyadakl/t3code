import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";

it.layer(ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))(
  "ProjectStoreV2",
  (it) => {
    it.effect("stores a model selection without options as JSON without an options key", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make("project-null-options");
        const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
        yield* projects.apply({
          sequence: 1,
          eventId: EventId.make("event-null-options"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: "2026-03-24T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: "Null options project",
            workspaceRoot: "/tmp/project-null-options",
            defaultModelSelection: modelSelection,
            scripts: [],
            createdAt: "2026-03-24T00:00:00.000Z",
            updatedAt: "2026-03-24T00:00:00.000Z",
          },
        });

        const rows = yield* sql<{ readonly defaultModelSelection: string | null }>`
          SELECT default_model_selection_json AS "defaultModelSelection"
          FROM projection_projects
          WHERE project_id = ${projectId}
        `;
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.strictEqual(rows[0]?.defaultModelSelection, JSON.stringify(modelSelection));
        assert.deepStrictEqual(
          Option.getOrNull(yield* projects.get(projectId))?.defaultModelSelection,
          modelSelection,
        );
      }),
    );

    it.effect("persists the archive time, keeps it across other updates, and clears it", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const projectId = ProjectId.make("project-archive");
        const event = {
          aggregateKind: "project",
          aggregateId: projectId,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
        } as const;
        const metaUpdated = (
          sequence: number,
          payload: { title?: string; archivedAt?: string | null },
        ) =>
          projects.apply({
            ...event,
            sequence,
            eventId: EventId.make(`event-archive-${sequence}`),
            occurredAt: "2026-03-25T00:00:00.000Z",
            type: "project.meta-updated",
            payload: { projectId, ...payload, updatedAt: "2026-03-25T00:00:00.000Z" },
          });
        const archivedAt = () =>
          projects
            .getShell(projectId)
            .pipe(Effect.map((shell) => Option.getOrNull(shell)?.archivedAt));

        yield* projects.apply({
          ...event,
          sequence: 1,
          eventId: EventId.make("event-archive-1"),
          occurredAt: "2026-03-24T00:00:00.000Z",
          type: "project.created",
          payload: {
            projectId,
            title: "Archive project",
            workspaceRoot: "/tmp/project-archive",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-03-24T00:00:00.000Z",
            updatedAt: "2026-03-24T00:00:00.000Z",
          },
        });
        assert.strictEqual(yield* archivedAt(), null);

        yield* metaUpdated(2, { archivedAt: "2026-03-25T00:00:00.000Z" });
        assert.strictEqual(yield* archivedAt(), "2026-03-25T00:00:00.000Z");

        yield* metaUpdated(3, { title: "Renamed" });
        assert.strictEqual(yield* archivedAt(), "2026-03-25T00:00:00.000Z");

        yield* metaUpdated(4, { archivedAt: null });
        assert.strictEqual(yield* archivedAt(), null);
      }),
    );
  },
);
