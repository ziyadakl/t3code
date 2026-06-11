import {
  CheckpointRef,
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ServerConfig } from "../../config.ts";

const TestLayer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-projection-rewind-test-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(TestLayer)("OrchestrationProjectionPipeline (conversation-rewind)", (it) => {
  // ADR-0002: `thread.conversation-rewound` must FLIP `abandoned` on the rewound
  // prompt and everything forward of it — never delete — across messages and
  // turns. Mirrors the `thread.reverted` shape but is non-destructive.
  it.effect("marks forward messages abandoned without deleting any rows", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;

      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      const projectId = ProjectId.make("project-rw");
      const threadId = ThreadId.make("thread-rw");
      const t0 = "2026-05-01T00:00:00.000Z";

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-rw-1"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: t0,
        commandId: CommandId.make("cmd-rw-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-rw-1"),
        metadata: {},
        payload: {
          projectId,
          title: "Project RW",
          workspaceRoot: "/tmp/project-rw",
          defaultModelSelection: null,
          scripts: [],
          createdAt: t0,
          updatedAt: t0,
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-rw-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: t0,
        commandId: CommandId.make("cmd-rw-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-rw-2"),
        metadata: {},
        payload: {
          threadId,
          projectId,
          title: "Thread RW",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: t0,
          updatedAt: t0,
        },
      });

      const sendMessage = (suffix: string, role: "user" | "assistant", createdAt: string) =>
        appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.make(`evt-rw-msg-${suffix}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: createdAt,
          commandId: CommandId.make(`cmd-rw-msg-${suffix}`),
          causationEventId: null,
          correlationId: CorrelationId.make(`cmd-rw-msg-${suffix}`),
          metadata: {},
          payload: {
            threadId,
            messageId: MessageId.make(`message-${suffix}`),
            role,
            text: suffix,
            turnId: null,
            streaming: false,
            createdAt,
            updatedAt: createdAt,
          },
        });

      yield* sendMessage("a-user", "user", "2026-05-01T00:01:00.000Z");
      yield* sendMessage("a-assistant", "assistant", "2026-05-01T00:01:01.000Z");
      yield* sendMessage("b-user", "user", "2026-05-01T00:01:02.000Z"); // rewind target
      yield* sendMessage("b-assistant", "assistant", "2026-05-01T00:01:03.000Z");

      // Rewind to the b-user prompt.
      yield* appendAndProject({
        type: "thread.conversation-rewound",
        eventId: EventId.make("evt-rw-rewound"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-05-01T00:02:00.000Z",
        commandId: CommandId.make("cmd-rw-rewound"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-rw-rewound"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-b-user"),
          anchorProviderMessageUuid: "claude-uuid-a-assistant",
          turnCount: 0,
        },
      });

      // Non-destructive: all four message rows still exist.
      const total = yield* sql<{
        readonly count: number;
      }>`SELECT COUNT(*) AS count FROM projection_thread_messages WHERE thread_id = ${threadId}`;
      assert.equal(total[0]?.count, 4);

      // The rewound prompt and everything forward are flagged abandoned.
      const abandoned = yield* sql<{
        readonly message_id: string;
      }>`
        SELECT message_id FROM projection_thread_messages
        WHERE thread_id = ${threadId} AND abandoned = 1
        ORDER BY message_id ASC
      `;
      assert.deepEqual(
        abandoned.map((row) => row.message_id),
        ["message-b-assistant", "message-b-user"],
      );

      // Earlier messages stay visible.
      const kept = yield* sql<{
        readonly message_id: string;
      }>`
        SELECT message_id FROM projection_thread_messages
        WHERE thread_id = ${threadId} AND abandoned = 0
        ORDER BY message_id ASC
      `;
      assert.deepEqual(
        kept.map((row) => row.message_id),
        ["message-a-assistant", "message-a-user"],
      );
    }),
  );

  // The turn-cut must align with the prompt timestamp: a turn's `requested_at`
  // (the user-prompt time, carried from the pending start) at or after the
  // rewound prompt flips abandoned, while the earlier turn is retained.
  it.effect("marks forward turns abandoned without deleting them", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;

      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      const projectId = ProjectId.make("project-rwt");
      const threadId = ThreadId.make("thread-rwt");
      const t0 = "2026-06-01T00:00:00.000Z";

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-rwt-1"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: t0,
        commandId: CommandId.make("cmd-rwt-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-rwt-1"),
        metadata: {},
        payload: {
          projectId,
          title: "Project RWT",
          workspaceRoot: "/tmp/project-rwt",
          defaultModelSelection: null,
          scripts: [],
          createdAt: t0,
          updatedAt: t0,
        },
      });
      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-rwt-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: t0,
        commandId: CommandId.make("cmd-rwt-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-rwt-2"),
        metadata: {},
        payload: {
          threadId,
          projectId,
          title: "Thread RWT",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: t0,
          updatedAt: t0,
        },
      });

      // Seed two turns. Each: a user prompt + a turn-start-request (same time) +
      // a turn-diff-completed promoting the pending start to a concrete turn,
      // which preserves `requested_at` = the prompt time.
      const seedTurn = (
        suffix: string,
        promptAt: string,
        turnCount: number,
      ) =>
        Effect.gen(function* () {
          yield* appendAndProject({
            type: "thread.message-sent",
            eventId: EventId.make(`evt-rwt-msg-${suffix}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: promptAt,
            commandId: CommandId.make(`cmd-rwt-msg-${suffix}`),
            causationEventId: null,
            correlationId: CorrelationId.make(`cmd-rwt-msg-${suffix}`),
            metadata: {},
            payload: {
              threadId,
              messageId: MessageId.make(`message-${suffix}`),
              role: "user",
              text: suffix,
              turnId: null,
              streaming: false,
              createdAt: promptAt,
              updatedAt: promptAt,
            },
          });
          yield* appendAndProject({
            type: "thread.turn-start-requested",
            eventId: EventId.make(`evt-rwt-start-${suffix}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: promptAt,
            commandId: CommandId.make(`cmd-rwt-start-${suffix}`),
            causationEventId: null,
            correlationId: CorrelationId.make(`cmd-rwt-start-${suffix}`),
            metadata: {},
            payload: {
              threadId,
              messageId: MessageId.make(`message-${suffix}`),
              runtimeMode: "full-access",
              createdAt: promptAt,
            },
          });
          yield* appendAndProject({
            type: "thread.turn-diff-completed",
            eventId: EventId.make(`evt-rwt-diff-${suffix}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: promptAt,
            commandId: CommandId.make(`cmd-rwt-diff-${suffix}`),
            causationEventId: null,
            correlationId: CorrelationId.make(`cmd-rwt-diff-${suffix}`),
            metadata: {},
            payload: {
              threadId,
              turnId: TurnId.make(`turn-${suffix}`),
              checkpointTurnCount: turnCount,
              checkpointRef: CheckpointRef.make(`refs/t3/checkpoints/thread-rwt/turn/${turnCount}`),
              status: "ready",
              files: [],
              assistantMessageId: MessageId.make(`assistant-${suffix}`),
              completedAt: promptAt,
            },
          });
        });

      yield* seedTurn("t1", "2026-06-01T00:01:00.000Z", 1);
      yield* seedTurn("t2", "2026-06-01T00:02:00.000Z", 2); // rewind target turn

      // Confirm the concrete turns carry the prompt time as requested_at.
      const seeded = yield* sql<{
        readonly turn_id: string;
        readonly requested_at: string;
      }>`
        SELECT turn_id, requested_at FROM projection_turns
        WHERE thread_id = ${threadId} AND turn_id IS NOT NULL
        ORDER BY turn_id ASC
      `;
      assert.equal(seeded.length, 2);

      yield* appendAndProject({
        type: "thread.conversation-rewound",
        eventId: EventId.make("evt-rwt-rewound"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-06-01T00:03:00.000Z",
        commandId: CommandId.make("cmd-rwt-rewound"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-rwt-rewound"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-t2"),
          turnCount: 1,
        },
      });

      // Non-destructive: both turns survive.
      const all = yield* sql<{
        readonly count: number;
      }>`SELECT COUNT(*) AS count FROM projection_turns WHERE thread_id = ${threadId} AND turn_id IS NOT NULL`;
      assert.equal(all[0]?.count, 2);

      const abandonedTurns = yield* sql<{
        readonly turn_id: string;
      }>`
        SELECT turn_id FROM projection_turns
        WHERE thread_id = ${threadId} AND abandoned = 1 AND turn_id IS NOT NULL
        ORDER BY turn_id ASC
      `;
      assert.deepEqual(
        abandonedTurns.map((row) => row.turn_id),
        ["turn-t2"],
      );
    }),
  );
});
