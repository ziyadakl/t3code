import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);

const seedArchivedProject = Effect.gen(function* () {
  const now = "2026-01-01T00:00:00.000Z";
  const initial = createEmptyReadModel(now);
  const withProject = yield* projectEvent(initial, {
    sequence: 1,
    eventId: asEventId("evt-project-create"),
    aggregateKind: "project",
    aggregateId: asProjectId("project-archived"),
    type: "project.created",
    occurredAt: now,
    commandId: asCommandId("cmd-project-create"),
    causationEventId: null,
    correlationId: asCommandId("cmd-project-create"),
    metadata: {},
    payload: {
      projectId: asProjectId("project-archived"),
      title: "Project Archived",
      workspaceRoot: "/tmp/project-archived",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });

  return yield* projectEvent(withProject, {
    sequence: 2,
    eventId: asEventId("evt-project-archive"),
    aggregateKind: "project",
    aggregateId: asProjectId("project-archived"),
    type: "project.archived",
    occurredAt: now,
    commandId: asCommandId("cmd-project-archive"),
    causationEventId: null,
    correlationId: asCommandId("cmd-project-archive"),
    metadata: {},
    payload: {
      projectId: asProjectId("project-archived"),
      archivedAt: now,
      updatedAt: now,
    },
  });
});

it.layer(NodeServices.layer)("decider archive guards", (it) => {
  it.effect("rejects creating a thread under an archived project", () =>
    Effect.gen(function* () {
      const readModel = yield* seedArchivedProject;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.create",
            commandId: asCommandId("cmd-thread-create-archived"),
            threadId: asThreadId("thread-under-archived"),
            projectId: asProjectId("project-archived"),
            title: "Thread Under Archived",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt: "2026-01-01T00:00:01.000Z",
          },
          readModel,
        }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("is already archived");
    }),
  );
});
