import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { and, isNotNull, lt } from "drizzle-orm";

import { RelayDb } from "../db.ts";
import {
  relayAgentActivityRows,
  relayDeliveryAttempts,
  relayLiveActivities,
} from "../persistence/schema.ts";

export class RelayMaintenancePersistenceError extends Data.TaggedError(
  "RelayMaintenancePersistenceError",
)<{
  readonly cause: unknown;
}> {}

export interface MaintenanceShape {
  readonly pruneExpired: Effect.Effect<void, RelayMaintenancePersistenceError>;
}

export class Maintenance extends Context.Service<Maintenance, MaintenanceShape>()(
  "t3code-relay/maintenance/Maintenance",
) {}

const make = Effect.gen(function* () {
  const db = yield* RelayDb;

  const pruneExpired: MaintenanceShape["pruneExpired"] = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const activityCutoff = DateTime.formatIso(DateTime.subtract(now, { hours: 24 }));
    const historicalCutoff = DateTime.formatIso(DateTime.subtract(now, { days: 30 }));
    yield* Effect.all(
      [
        db
          .delete(relayAgentActivityRows)
          .where(lt(relayAgentActivityRows.updatedAt, activityCutoff)),
        db
          .delete(relayDeliveryAttempts)
          .where(lt(relayDeliveryAttempts.createdAt, historicalCutoff)),
        db
          .delete(relayLiveActivities)
          .where(
            and(
              isNotNull(relayLiveActivities.endedAt),
              lt(relayLiveActivities.endedAt, historicalCutoff),
            ),
          ),
      ],
      { concurrency: 3, discard: true },
    );
  }).pipe(
    Effect.withSpan("relay.maintenance.prune_expired"),
    Effect.mapError((cause) => new RelayMaintenancePersistenceError({ cause })),
  );

  return Maintenance.of({ pruneExpired });
});

export const layer = Layer.effect(Maintenance, make);
