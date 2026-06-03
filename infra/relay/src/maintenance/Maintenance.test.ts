import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RelayDb, type RelayDatabase } from "../db.ts";
import {
  relayAgentActivityRows,
  relayDeliveryAttempts,
  relayLiveActivities,
} from "../persistence/schema.ts";
import * as Maintenance from "./Maintenance.ts";

describe("Maintenance", () => {
  it.effect("prunes bounded-retention relay state", () => {
    const deletedTables: Array<unknown> = [];
    const fakeDb = {
      delete: (table: unknown) => {
        deletedTables.push(table);
        return {
          where: () => Effect.void,
        };
      },
    } as unknown as RelayDatabase;

    return Effect.gen(function* () {
      const maintenance = yield* Maintenance.Maintenance;
      yield* maintenance.pruneExpired;

      expect(deletedTables).toEqual([
        relayAgentActivityRows,
        relayDeliveryAttempts,
        relayLiveActivities,
      ]);
    }).pipe(Effect.provide(Maintenance.layer.pipe(Layer.provide(Layer.succeed(RelayDb, fakeDb)))));
  });
});
