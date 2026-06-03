import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RelayDb, type RelayDatabase } from "../db.ts";
import * as Entitlements from "./Entitlements.ts";

function testLayer(rows: ReadonlyArray<Record<string, unknown>>) {
  const fakeDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Effect.succeed(rows),
        }),
      }),
    }),
  } as unknown as RelayDatabase;
  return Entitlements.layer.pipe(Layer.provide(Layer.succeed(RelayDb, fakeDb)));
}

describe("Entitlements", () => {
  it.effect("uses the platform defaults when a user has no override", () =>
    Effect.gen(function* () {
      const entitlements = yield* Entitlements.Entitlements;
      expect(yield* entitlements.getEffectiveForUser("user-1")).toEqual({
        managedEndpointLimit: 3,
        mobileDeviceLimit: 5,
        rateLimitTier: "standard",
      });
    }).pipe(Effect.provide(testLayer([]))),
  );

  it.effect("applies sparse per-user overrides", () =>
    Effect.gen(function* () {
      const entitlements = yield* Entitlements.Entitlements;
      expect(yield* entitlements.getEffectiveForUser("user-1")).toEqual({
        managedEndpointLimit: 12,
        mobileDeviceLimit: 5,
        rateLimitTier: "trusted",
      });
    }).pipe(
      Effect.provide(
        testLayer([
          {
            managedEndpointLimit: 12,
            mobileDeviceLimit: null,
            rateLimitTier: "trusted",
          },
        ]),
      ),
    ),
  );
});
