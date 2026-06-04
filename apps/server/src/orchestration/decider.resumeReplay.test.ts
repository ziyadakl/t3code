import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);

const seedThread = Effect.gen(function* () {
  const initial = createEmptyReadModel(now);
  const withProject = yield* projectEvent(initial, {
    sequence: 1,
    eventId: asEventId("evt-project"),
    aggregateKind: "project",
    aggregateId: ProjectId.make("project-replay"),
    type: "project.created",
    occurredAt: now,
    commandId: asCommandId("cmd-project"),
    causationEventId: null,
    correlationId: asCommandId("cmd-project"),
    metadata: {},
    payload: {
      projectId: ProjectId.make("project-replay"),
      title: "Replay",
      workspaceRoot: "/tmp/project-replay",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
  return yield* projectEvent(withProject, {
    sequence: 2,
    eventId: asEventId("evt-thread"),
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-replay"),
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId("cmd-thread"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread"),
    metadata: {},
    payload: {
      threadId: ThreadId.make("thread-replay"),
      projectId: ProjectId.make("project-replay"),
      title: "Replay Thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("claude-default"),
        model: "claude-opus",
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

it.layer(NodeServices.layer)("decider resume-replay", (it) => {
  it.effect("records a historical user message WITHOUT requesting a turn", () =>
    Effect.gen(function* () {
      const readModel = yield* seedThread;

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.user.record",
          commandId: asCommandId("cmd-user-record"),
          threadId: ThreadId.make("thread-replay"),
          messageId: MessageId.make("msg-replay-1"),
          text: "fix the budget calc",
          createdAt: now,
        },
        readModel,
      });

      const events = Array.isArray(result) ? result : [result];

      // The whole point of the new command: a user message is recorded for
      // display, but NO turn is fired (contrast thread.turn.start, which emits
      // both message-sent AND turn-start-requested).
      expect(events.map((event) => event.type)).toEqual(["thread.message-sent"]);

      const event = events[0];
      if (event?.type === "thread.message-sent") {
        expect(event.payload.role).toBe("user");
        expect(event.payload.text).toBe("fix the budget calc");
        expect(event.payload.streaming).toBe(false);
        expect(event.payload.turnId).toBe(null);
      } else {
        throw new Error(`expected a thread.message-sent event, got ${event?.type}`);
      }
    }),
  );
});
