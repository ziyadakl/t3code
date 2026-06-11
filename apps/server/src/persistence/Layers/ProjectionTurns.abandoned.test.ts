import { CheckpointRef, MessageId, NonNegativeInt, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionTurnRepository } from "../Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "./ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionTurnRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionTurnRepository (conversation-rewind)", (it) => {
  // ADR-0002 non-destructive rewind: flip `abandoned` on turns requested at or
  // after the rewound prompt, never delete, and report the concrete-turn count.
  it.effect("markAbandonedFromRequestedAt flips forward turns without deleting them", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionTurnRepository;
      const threadId = ThreadId.make("thread-rewind-turns");

      const seed = (suffix: string, requestedAt: string, checkpointTurnCount: number) =>
        repository.upsertByTurnId({
          turnId: TurnId.make(`turn-${suffix}`),
          threadId,
          pendingMessageId: null,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          assistantMessageId: MessageId.make(`assistant-${suffix}`),
          state: "completed",
          requestedAt,
          startedAt: requestedAt,
          completedAt: requestedAt,
          checkpointTurnCount: NonNegativeInt.make(checkpointTurnCount),
          checkpointRef: CheckpointRef.make(`ref-${suffix}`),
          checkpointStatus: "ready",
          checkpointFiles: [],
        });

      yield* seed("a", "2026-03-01T10:00:01.000Z", 1);
      yield* seed("b", "2026-03-01T10:00:03.000Z", 2); // at/after the cut
      yield* seed("c", "2026-03-01T10:00:05.000Z", 3);

      const flipped = yield* repository.markAbandonedFromRequestedAt({
        threadId,
        fromRequestedAt: "2026-03-01T10:00:03.000Z",
      });
      assert.equal(flipped, 2); // turn-b + turn-c

      // Non-destructive: all three turns survive the unfiltered repo read.
      const turns = yield* repository.listByThreadId({ threadId });
      assert.equal(turns.length, 3);

      const abandoned = turns
        .filter((turn) => turn.abandoned === true)
        .map((turn) => String(turn.turnId))
        .toSorted();
      assert.deepEqual(abandoned, ["turn-b", "turn-c"]);

      const kept = turns.find((turn) => turn.turnId === "turn-a");
      assert.equal(kept?.abandoned, false);
    }),
  );
});
