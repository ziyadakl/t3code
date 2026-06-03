import type {
  RelayClientDeviceRecord,
  RelayDeviceRegistrationRequest,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { and, count, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { RelayDb } from "../db.ts";
import * as Entitlements from "../entitlements/Entitlements.ts";
import { relayLiveActivities, relayMobileDevices } from "../persistence/schema.ts";

export class DeviceRegistrationPersistenceError extends Data.TaggedError(
  "DeviceRegistrationPersistenceError",
)<{
  readonly cause: unknown;
}> {}

export class DeviceUnregistrationPersistenceError extends Data.TaggedError(
  "DeviceUnregistrationPersistenceError",
)<{
  readonly cause: unknown;
}> {}

export class DeviceListPersistenceError extends Data.TaggedError("DeviceListPersistenceError")<{
  readonly cause: unknown;
}> {}

export interface DevicesShape {
  readonly register: (input: {
    readonly userId: string;
    readonly registration: RelayDeviceRegistrationRequest;
  }) => Effect.Effect<
    void,
    DeviceRegistrationPersistenceError | Entitlements.UserResourceQuotaExceeded
  >;
  readonly unregister: (input: {
    readonly userId: string;
    readonly deviceId: string;
  }) => Effect.Effect<void, DeviceUnregistrationPersistenceError>;
  readonly listForUser: (input: {
    readonly userId: string;
  }) => Effect.Effect<ReadonlyArray<RelayClientDeviceRecord>, DeviceListPersistenceError>;
}

export class Devices extends Context.Service<Devices, DevicesShape>()(
  "t3code-relay/agentActivity/Devices",
) {}

const make = Effect.gen(function* () {
  const db = yield* RelayDb;
  const entitlements = yield* Entitlements.Entitlements;

  return Devices.of({
    register: Effect.fn("relay.devices.register")(
      function* (input) {
        yield* Effect.annotateCurrentSpan({
          "relay.mobile.device_id": input.registration.deviceId,
        });
        yield* entitlements.withUserLock(
          input.userId,
          Effect.gen(function* () {
            const updatedAt = DateTime.formatIso(yield* DateTime.now);
            const registration = input.registration;
            const existing = yield* db
              .select({ deviceId: relayMobileDevices.deviceId })
              .from(relayMobileDevices)
              .where(
                and(
                  eq(relayMobileDevices.userId, input.userId),
                  eq(relayMobileDevices.deviceId, registration.deviceId),
                ),
              )
              .limit(1);
            if (existing.length === 0) {
              const effective = yield* entitlements.getEffectiveForUser(input.userId);
              const deviceCounts = yield* db
                .select({ value: count() })
                .from(relayMobileDevices)
                .where(eq(relayMobileDevices.userId, input.userId));
              if ((deviceCounts[0]?.value ?? 0) >= effective.mobileDeviceLimit) {
                return yield* new Entitlements.UserResourceQuotaExceeded({
                  resource: "mobile_devices",
                  limit: effective.mobileDeviceLimit,
                });
              }
            }

            yield* Effect.all(
              [
                registration.pushToken
                  ? db
                      .update(relayMobileDevices)
                      .set({ pushToken: null, updatedAt })
                      .where(eq(relayMobileDevices.pushToken, registration.pushToken))
                  : Effect.void,
                registration.pushToStartToken
                  ? db
                      .update(relayMobileDevices)
                      .set({ pushToStartToken: null, updatedAt })
                      .where(eq(relayMobileDevices.pushToStartToken, registration.pushToStartToken))
                  : Effect.void,
              ],
              { concurrency: 2, discard: true },
            );

            yield* db
              .insert(relayMobileDevices)
              .values({
                userId: input.userId,
                deviceId: registration.deviceId,
                label: registration.label,
                platform: registration.platform,
                iosMajorVersion: registration.iosMajorVersion,
                appVersion: registration.appVersion ?? null,
                pushToken: registration.pushToken ?? null,
                pushToStartToken: registration.pushToStartToken ?? null,
                preferencesJson: registration.preferences,
                createdAt: updatedAt,
                updatedAt,
              })
              .onConflictDoUpdate({
                target: [relayMobileDevices.userId, relayMobileDevices.deviceId],
                set: {
                  platform: registration.platform,
                  label: registration.label,
                  iosMajorVersion: registration.iosMajorVersion,
                  appVersion: registration.appVersion ?? null,
                  pushToken: sql`coalesce(excluded.push_token, ${relayMobileDevices.pushToken})`,
                  pushToStartToken: sql`coalesce(
                    excluded.push_to_start_token,
                    ${relayMobileDevices.pushToStartToken}
                  )`,
                  preferencesJson: registration.preferences,
                  updatedAt,
                },
              });
          }),
        );
      },
      Effect.mapError((cause) =>
        cause instanceof Entitlements.UserResourceQuotaExceeded
          ? cause
          : new DeviceRegistrationPersistenceError({ cause }),
      ),
    ),
    unregister: Effect.fn("relay.devices.unregister")(
      function* (input) {
        yield* Effect.annotateCurrentSpan({
          "relay.mobile.device_id": input.deviceId,
        });
        yield* Effect.all(
          [
            db
              .delete(relayLiveActivities)
              .where(
                and(
                  eq(relayLiveActivities.userId, input.userId),
                  eq(relayLiveActivities.deviceId, input.deviceId),
                ),
              ),
            db
              .delete(relayMobileDevices)
              .where(
                and(
                  eq(relayMobileDevices.userId, input.userId),
                  eq(relayMobileDevices.deviceId, input.deviceId),
                ),
              ),
          ],
          { concurrency: 2, discard: true },
        );
      },
      Effect.mapError((cause) => new DeviceUnregistrationPersistenceError({ cause })),
    ),
    listForUser: Effect.fn("relay.devices.listForUser")(
      function* (input) {
        const rows = yield* db
          .select({
            deviceId: relayMobileDevices.deviceId,
            label: relayMobileDevices.label,
            platform: relayMobileDevices.platform,
            iosMajorVersion: relayMobileDevices.iosMajorVersion,
            appVersion: relayMobileDevices.appVersion,
            preferences: relayMobileDevices.preferencesJson,
            updatedAt: relayMobileDevices.updatedAt,
          })
          .from(relayMobileDevices)
          .where(eq(relayMobileDevices.userId, input.userId));
        return rows.map((row) => ({
          deviceId: row.deviceId,
          label: row.label,
          platform: row.platform,
          iosMajorVersion: row.iosMajorVersion,
          appVersion: row.appVersion,
          notifications: {
            enabled: row.preferences.notificationsEnabled,
            notifyOnApproval: row.preferences.notifyOnApproval,
            notifyOnInput: row.preferences.notifyOnInput,
            notifyOnCompletion: row.preferences.notifyOnCompletion,
            notifyOnFailure: row.preferences.notifyOnFailure,
          },
          liveActivities: {
            enabled: row.preferences.liveActivitiesEnabled,
          },
          updatedAt: row.updatedAt,
        }));
      },
      Effect.mapError((cause) => new DeviceListPersistenceError({ cause })),
    ),
  });
});

export const layer = Layer.effect(Devices, make);
