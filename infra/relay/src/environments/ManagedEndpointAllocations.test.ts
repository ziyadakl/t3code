import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RelayDb, type RelayDatabase } from "../db.ts";
import * as Entitlements from "../entitlements/Entitlements.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";

function testLayer(fakeDb: RelayDatabase, managedEndpointLimit = 3) {
  return ManagedEndpointAllocations.ManagedEndpointAllocations.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RelayDb, fakeDb),
        Layer.succeed(
          Entitlements.Entitlements,
          Entitlements.Entitlements.of({
            getEffectiveForUser: () =>
              Effect.succeed({
                managedEndpointLimit,
                mobileDeviceLimit: 5,
                rateLimitTier: "standard",
              }),
            withUserLock: (_userId, effect) => effect,
          }),
        ),
      ),
    ),
  );
}

describe("ManagedEndpointAllocations", () => {
  it.effect("rejects a new managed endpoint when every slot is reserved", () => {
    let selectCount = 0;
    const fakeDb = {
      select: () => {
        selectCount++;
        return {
          from: () => ({
            where: () =>
              selectCount === 1
                ? { limit: () => Effect.succeed([]) }
                : Effect.succeed([{ value: 3 }]),
          }),
        };
      },
      insert: () => {
        throw new Error("allocation insert should not run");
      },
    } as unknown as RelayDatabase;

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      const error = yield* Effect.flip(
        allocations.reserve({
          userId: "user-1",
          environmentId: "env-4",
          hostname: "env-4.example.test",
          tunnelName: "tunnel-env-4",
        }),
      );

      expect(error).toEqual(
        new Entitlements.UserResourceQuotaExceeded({
          resource: "managed_endpoints",
          limit: 3,
        }),
      );
    }).pipe(Effect.provide(testLayer(fakeDb)));
  });

  it.effect("returns an existing reservation even when the user is at the cap", () => {
    const existing: ManagedEndpointAllocations.ManagedEndpointAllocation = {
      userId: "user-1",
      environmentId: "env-1",
      hostname: "env-1.example.test",
      tunnelName: "tunnel-env-1",
      tunnelId: null,
      dnsRecordId: null,
      readyAt: null,
      deprovisionRequestedAt: null,
      lastDeprovisionAttemptAt: null,
      lastDeprovisionError: null,
    };
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Effect.succeed([existing]),
          }),
        }),
      }),
      insert: () => {
        throw new Error("allocation insert should not run");
      },
    } as unknown as RelayDatabase;

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      expect(
        yield* allocations.reserve({
          userId: "user-1",
          environmentId: "env-1",
          hostname: "env-1.example.test",
          tunnelName: "tunnel-env-1",
        }),
      ).toEqual(existing);
    }).pipe(Effect.provide(testLayer(fakeDb, 0)));
  });
});
