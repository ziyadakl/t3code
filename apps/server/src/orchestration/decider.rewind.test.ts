import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";

const seedReadModel = Effect.gen(function* () {
  const initial = createEmptyReadModel(now);
  const withProject = yield* projectEvent(initial, {
    sequence: 1,
    eventId: EventId.make("evt-project"),
    aggregateKind: "project",
    aggregateId: ProjectId.make("project-rw"),
    type: "project.created",
    occurredAt: now,
    commandId: CommandId.make("cmd-project"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-project"),
    metadata: {},
    payload: {
      projectId: ProjectId.make("project-rw"),
      title: "Project RW",
      workspaceRoot: "/tmp/project-rw",
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
    aggregateId: ThreadId.make("thread-rw"),
    type: "thread.created",
    occurredAt: now,
    commandId: CommandId.make("cmd-thread"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-thread"),
    metadata: {},
    payload: {
      threadId: ThreadId.make("thread-rw"),
      projectId: ProjectId.make("project-rw"),
      title: "Thread RW",
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

it.layer(NodeServices.layer)("decider conversation-rewind", (it) => {
  // ADR-0002: the client `thread.conversation.rewind` command records the
  // request the rewind reactor (WS-2) consumes.
  it.effect("emits thread.conversation-rewind-requested for the rewind command", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.conversation.rewind",
          commandId: CommandId.make("cmd-rewind"),
          threadId: ThreadId.make("thread-rw"),
          messageId: MessageId.make("message-target"),
          createdAt: now,
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;
      assert.equal(event?.type, "thread.conversation-rewind-requested");
      if (event?.type === "thread.conversation-rewind-requested") {
        assert.equal(event.payload.threadId, "thread-rw");
        assert.equal(event.payload.messageId, "message-target");
      }
    }),
  );

  // The server-only bridge command turns into the terminal rewound event the
  // ProjectionPipeline applies as a non-destructive "mark abandoned".
  it.effect("turns thread.conversation-rewind.complete into thread.conversation-rewound", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.conversation-rewind.complete",
          commandId: CommandId.make("cmd-rewind-complete"),
          threadId: ThreadId.make("thread-rw"),
          messageId: MessageId.make("message-target"),
          anchorProviderMessageUuid: "claude-uuid-anchor",
          turnCount: NonNegativeInt.make(2),
          createdAt: now,
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;
      assert.equal(event?.type, "thread.conversation-rewound");
      if (event?.type === "thread.conversation-rewound") {
        assert.equal(event.payload.threadId, "thread-rw");
        assert.equal(event.payload.messageId, "message-target");
        assert.equal(event.payload.anchorProviderMessageUuid, "claude-uuid-anchor");
        assert.equal(event.payload.turnCount, 2);
      }
    }),
  );

  // The decoupled file-restore command records its own request, distinct from
  // the destructive checkpoint revert.
  it.effect("emits thread.files-restore-requested for the file-restore command", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.files.restore",
          commandId: CommandId.make("cmd-files-restore"),
          threadId: ThreadId.make("thread-rw"),
          turnCount: NonNegativeInt.make(1),
          createdAt: now,
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;
      assert.equal(event?.type, "thread.files-restore-requested");
      if (event?.type === "thread.files-restore-requested") {
        assert.equal(event.payload.threadId, "thread-rw");
        assert.equal(event.payload.turnCount, 1);
      }
    }),
  );
});
