import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { isSqlError } from "effect/unstable/sql/SqlError";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { RelayRateLimitTier } from "@t3tools/contracts/relay";

import { RelayDb } from "../db.ts";
import { relayUserEntitlements } from "../persistence/schema.ts";

export const DEFAULT_MANAGED_ENDPOINT_LIMIT = 3;
export const DEFAULT_MOBILE_DEVICE_LIMIT = 5;

export type RelayQuotaResource = "managed_endpoints" | "mobile_devices";

export interface EffectiveUserEntitlements {
  readonly managedEndpointLimit: number;
  readonly mobileDeviceLimit: number;
  readonly rateLimitTier: RelayRateLimitTier;
}

export class UserEntitlementPersistenceError extends Data.TaggedError(
  "UserEntitlementPersistenceError",
)<{
  readonly cause: unknown;
}> {}

export class UserResourceQuotaExceeded extends Data.TaggedError("UserResourceQuotaExceeded")<{
  readonly resource: RelayQuotaResource;
  readonly limit: number;
}> {}

export interface EntitlementsShape {
  readonly getEffectiveForUser: (
    userId: string,
  ) => Effect.Effect<EffectiveUserEntitlements, UserEntitlementPersistenceError>;
  readonly withUserLock: <A, E, R>(
    userId: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | UserEntitlementPersistenceError, R>;
}

export class Entitlements extends Context.Service<Entitlements, EntitlementsShape>()(
  "t3code-relay/entitlements/Entitlements",
) {}

const make = Effect.gen(function* () {
  const db = yield* RelayDb;

  const getEffectiveForUser: EntitlementsShape["getEffectiveForUser"] = Effect.fn(
    "relay.entitlements.get_effective_for_user",
  )(
    function* (userId) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const rows = yield* db
        .select({
          managedEndpointLimit: relayUserEntitlements.managedEndpointLimit,
          mobileDeviceLimit: relayUserEntitlements.mobileDeviceLimit,
          rateLimitTier: relayUserEntitlements.rateLimitTier,
        })
        .from(relayUserEntitlements)
        .where(
          and(
            eq(relayUserEntitlements.userId, userId),
            or(isNull(relayUserEntitlements.expiresAt), gt(relayUserEntitlements.expiresAt, now)),
          ),
        )
        .limit(1);
      const row = rows[0];
      return {
        managedEndpointLimit: row?.managedEndpointLimit ?? DEFAULT_MANAGED_ENDPOINT_LIMIT,
        mobileDeviceLimit: row?.mobileDeviceLimit ?? DEFAULT_MOBILE_DEVICE_LIMIT,
        rateLimitTier: row?.rateLimitTier ?? "standard",
      };
    },
    Effect.mapError((cause) => new UserEntitlementPersistenceError({ cause })),
  );

  const withUserLock: EntitlementsShape["withUserLock"] = (userId, effect) =>
    db.$client
      .withTransaction(
        Effect.gen(function* () {
          yield* db.$client`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`;
          return yield* effect;
        }),
      )
      .pipe(
        Effect.catchIf(isSqlError, (cause) =>
          Effect.fail(new UserEntitlementPersistenceError({ cause })),
        ),
      );

  return Entitlements.of({
    getEffectiveForUser,
    withUserLock,
  });
});

export const layer = Layer.effect(Entitlements, make);
