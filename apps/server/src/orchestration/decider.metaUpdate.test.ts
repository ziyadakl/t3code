import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";

const seedReadModel = Effect.gen(function* () {
  const initial = createEmptyReadModel(now);
  const withProject = yield* projectEvent(initial, {
    sequence: 1,
    eventId: EventId.make("evt-project"),
    aggregateKind: "project",
    aggregateId: ProjectId.make("project-meta"),
    type: "project.created",
    occurredAt: now,
    commandId: CommandId.make("cmd-project"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-project"),
    metadata: {},
    payload: {
      projectId: ProjectId.make("project-meta"),
      title: "Project Meta",
      workspaceRoot: "/tmp/project-meta",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
  return yield* projectEvent(withProject, {
    sequence: 2,
    eventId: EventId.make("evt-thread"),
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-meta"),
    type: "thread.created",
    occurredAt: now,
    commandId: CommandId.make("cmd-thread"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-thread"),
    metadata: {},
    payload: {
      threadId: ThreadId.make("thread-meta"),
      projectId: ProjectId.make("project-meta"),
      title: "Thread Meta",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });
});

it.layer(NodeServices.layer)("decider thread.meta.update titleSource", (it) => {
  it.effect("passes titleSource: 'user' through to the event payload", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-meta-user"),
          threadId: ThreadId.make("thread-meta"),
          title: "My Custom Title",
          titleSource: "user",
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;
      assert.equal(event?.type, "thread.meta-updated");
      if (event?.type === "thread.meta-updated") {
        assert.equal(event.payload.titleSource, "user");
        assert.equal(event.payload.title, "My Custom Title");
      }
    }),
  );

  it.effect("omits titleSource when absent from the command", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-meta-no-source"),
          threadId: ThreadId.make("thread-meta"),
          title: "Some Title",
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;
      assert.equal(event?.type, "thread.meta-updated");
      if (event?.type === "thread.meta-updated") {
        assert.isUndefined(event.payload.titleSource);
      }
    }),
  );
});
