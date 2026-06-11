import {
  CommandId,
  CorrelationId,
  EventId,
  type OrchestrationEvent,
  type OrchestrationThread,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { mapThreadDetailStreamItem } from "./ws.ts";

const threadId = ThreadId.make("thread-rwc-ws");

const baseEventFields = {
  sequence: 1,
  eventId: EventId.make("evt-1"),
  aggregateKind: "thread" as const,
  aggregateId: threadId,
  occurredAt: "2026-01-01T00:00:00.000Z",
  commandId: CommandId.make("cmd-1"),
  causationEventId: null,
  correlationId: CorrelationId.make("cmd-1"),
  metadata: {},
};

const cancelledEvent: OrchestrationEvent = {
  ...baseEventFields,
  type: "thread.conversation-rewind-cancelled",
  payload: { threadId, messageId: "message-target" as never },
};

const sessionSetEvent: OrchestrationEvent = {
  ...baseEventFields,
  type: "thread.session-set",
  payload: {
    threadId,
    session: {
      provider: "codex" as never,
      providerInstanceId: ProviderInstanceId.make("codex"),
      status: "ready",
    } as never,
  } as never,
};

const restoredThread = {
  id: threadId,
  messages: [{ id: "message-target" }],
} as unknown as OrchestrationThread;

it.effect("emits a fresh snapshot for the cancelled event (race-free restore)", () =>
  Effect.gen(function* () {
    const item = yield* mapThreadDetailStreamItem({
      event: cancelledEvent,
      threadId,
      snapshotSequence: 42,
      getThreadDetailById: () => Effect.succeed(Option.some(restoredThread)),
    });
    assert.equal(item.kind, "snapshot");
    if (item.kind === "snapshot") {
      assert.equal(item.snapshot.snapshotSequence, 42);
      assert.equal(item.snapshot.thread, restoredThread);
    }
  }),
);

it.effect("forwards a bare event for non-cancel events", () =>
  Effect.gen(function* () {
    const item = yield* mapThreadDetailStreamItem({
      event: sessionSetEvent,
      threadId,
      snapshotSequence: 7,
      getThreadDetailById: () => Effect.die(new Error("must not query for non-cancel events")),
    });
    assert.equal(item.kind, "event");
    if (item.kind === "event") {
      assert.equal(item.event.type, "thread.session-set");
    }
  }),
);

it.effect("falls back to forwarding the event when the thread detail is missing", () =>
  Effect.gen(function* () {
    const item = yield* mapThreadDetailStreamItem({
      event: cancelledEvent,
      threadId,
      snapshotSequence: 5,
      getThreadDetailById: () => Effect.succeed(Option.none()),
    });
    assert.equal(item.kind, "event");
    if (item.kind === "event") {
      assert.equal(item.event.type, "thread.conversation-rewind-cancelled");
    }
  }),
);
