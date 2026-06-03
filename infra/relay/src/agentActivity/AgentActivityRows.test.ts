import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RelayDb, type RelayDatabase } from "../db.ts";
import * as AgentActivityRows from "./AgentActivityRows.ts";

const state: RelayAgentActivityState = {
  environmentId: "env-1" as RelayAgentActivityState["environmentId"],
  threadId: "thread-51" as RelayAgentActivityState["threadId"],
  projectTitle: "Project",
  threadTitle: "Thread",
  phase: "running",
  headline: "Running",
  modelTitle: "gpt-5",
  updatedAt: "2026-06-03T00:00:00.000Z",
  deepLink: "/threads/env-1/thread-51",
};

describe("AgentActivityRows", () => {
  it.effect("rejects a new active thread after the per-environment cap", () => {
    let selectCount = 0;
    const sqlClient = Object.assign(() => Effect.void, {
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    });
    const fakeDb = {
      $client: sqlClient,
      select: () => {
        selectCount++;
        return {
          from: () => ({
            where: () =>
              selectCount === 1
                ? { limit: () => Effect.succeed([]) }
                : Effect.succeed([{ value: 50 }]),
          }),
        };
      },
      insert: () => {
        throw new Error("activity insert should not run");
      },
    } as unknown as RelayDatabase;

    return Effect.gen(function* () {
      const rows = yield* AgentActivityRows.AgentActivityRows;
      const error = yield* Effect.flip(
        rows.upsert({
          environmentPublicKey: "environment-public-key",
          state,
        }),
      );

      expect(error).toEqual(
        new AgentActivityRows.AgentActivityRowQuotaExceeded({
          resource: "active_agent_threads",
          limit: 50,
        }),
      );
    }).pipe(
      Effect.provide(AgentActivityRows.layer.pipe(Layer.provide(Layer.succeed(RelayDb, fakeDb)))),
    );
  });
});
