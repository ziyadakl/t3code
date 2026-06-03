import type { RelayManagedEndpoint } from "@t3tools/contracts/relay";
import { and, count, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RelayDb } from "../db.ts";
import { isManagedEndpointHostname, managedEndpointForHostname } from "../deploymentConfig.ts";
import * as Entitlements from "../entitlements/Entitlements.ts";
import { relayEnvironmentLinks, relayManagedEndpointAllocations } from "../persistence/schema.ts";

export interface ManagedEndpointAllocation {
  readonly userId: string;
  readonly environmentId: string;
  readonly hostname: string;
  readonly tunnelId: string | null;
  readonly tunnelName: string;
  readonly dnsRecordId: string | null;
  readonly readyAt: string | null;
  readonly deprovisionRequestedAt: string | null;
  readonly lastDeprovisionAttemptAt: string | null;
  readonly lastDeprovisionError: string | null;
}

export function resolveReadyManagedEndpoint(input: {
  readonly allocation: ManagedEndpointAllocation;
  readonly baseDomain: string | undefined;
}): RelayManagedEndpoint | null {
  if (
    !input.baseDomain ||
    input.allocation.readyAt === null ||
    input.allocation.deprovisionRequestedAt !== null ||
    input.allocation.tunnelId === null ||
    input.allocation.dnsRecordId === null ||
    !isManagedEndpointHostname(input.allocation.hostname, input.baseDomain)
  ) {
    return null;
  }
  return managedEndpointForHostname(input.allocation.hostname);
}

export class ManagedEndpointAllocationPersistenceError extends Data.TaggedError(
  "ManagedEndpointAllocationPersistenceError",
)<{
  readonly cause: unknown;
}> {}

interface ManagedEndpointAllocationKey {
  readonly userId: string;
  readonly environmentId: string;
}

interface ReserveManagedEndpointAllocationInput extends ManagedEndpointAllocationKey {
  readonly hostname: string;
  readonly tunnelName: string;
}

interface RecordManagedEndpointTunnelInput extends ManagedEndpointAllocationKey {
  readonly tunnelId: string;
}

interface RecordManagedEndpointDnsInput extends ManagedEndpointAllocationKey {
  readonly dnsRecordId: string;
}

interface RecordManagedEndpointDeprovisionFailureInput extends ManagedEndpointAllocationKey {
  readonly cause: unknown;
}

export interface ManagedEndpointAllocationsShape {
  readonly get: (
    input: ManagedEndpointAllocationKey,
  ) => Effect.Effect<ManagedEndpointAllocation | null, ManagedEndpointAllocationPersistenceError>;
  readonly reserve: (
    input: ReserveManagedEndpointAllocationInput,
  ) => Effect.Effect<
    ManagedEndpointAllocation,
    ManagedEndpointAllocationPersistenceError | Entitlements.UserResourceQuotaExceeded
  >;
  readonly recordTunnel: (
    input: RecordManagedEndpointTunnelInput,
  ) => Effect.Effect<void, ManagedEndpointAllocationPersistenceError>;
  readonly recordDns: (
    input: RecordManagedEndpointDnsInput,
  ) => Effect.Effect<void, ManagedEndpointAllocationPersistenceError>;
  readonly markReady: (
    input: ManagedEndpointAllocationKey,
  ) => Effect.Effect<void, ManagedEndpointAllocationPersistenceError>;
  readonly requestDeprovision: (
    input: ManagedEndpointAllocationKey,
  ) => Effect.Effect<void, ManagedEndpointAllocationPersistenceError>;
  readonly markDeprovisionAttempt: (
    input: ManagedEndpointAllocationKey,
  ) => Effect.Effect<void, ManagedEndpointAllocationPersistenceError>;
  readonly recordDeprovisionFailure: (
    input: RecordManagedEndpointDeprovisionFailureInput,
  ) => Effect.Effect<void, ManagedEndpointAllocationPersistenceError>;
  readonly listCleanupCandidates: (input: {
    readonly orphanedBefore: string;
  }) => Effect.Effect<
    ReadonlyArray<ManagedEndpointAllocationKey>,
    ManagedEndpointAllocationPersistenceError
  >;
  readonly remove: (
    input: ManagedEndpointAllocationKey,
  ) => Effect.Effect<void, ManagedEndpointAllocationPersistenceError>;
}

const allocationSelection = {
  userId: relayManagedEndpointAllocations.userId,
  environmentId: relayManagedEndpointAllocations.environmentId,
  hostname: relayManagedEndpointAllocations.hostname,
  tunnelId: relayManagedEndpointAllocations.tunnelId,
  tunnelName: relayManagedEndpointAllocations.tunnelName,
  dnsRecordId: relayManagedEndpointAllocations.dnsRecordId,
  readyAt: relayManagedEndpointAllocations.readyAt,
  deprovisionRequestedAt: relayManagedEndpointAllocations.deprovisionRequestedAt,
  lastDeprovisionAttemptAt: relayManagedEndpointAllocations.lastDeprovisionAttemptAt,
  lastDeprovisionError: relayManagedEndpointAllocations.lastDeprovisionError,
};

const whereAllocation = (input: ManagedEndpointAllocationKey) =>
  and(
    eq(relayManagedEndpointAllocations.userId, input.userId),
    eq(relayManagedEndpointAllocations.environmentId, input.environmentId),
  );

const persistenceError = (cause: unknown) =>
  cause instanceof ManagedEndpointAllocationPersistenceError
    ? cause
    : new ManagedEndpointAllocationPersistenceError({ cause });

const reservationError = (cause: unknown) =>
  cause instanceof Entitlements.UserResourceQuotaExceeded ? cause : persistenceError(cause);

const make = Effect.gen(function* () {
  const db = yield* RelayDb;
  const entitlements = yield* Entitlements.Entitlements;

  const get = Effect.fn("relay.managed_endpoint_allocations.get")(function* (
    input: ManagedEndpointAllocationKey,
  ) {
    return yield* db
      .select(allocationSelection)
      .from(relayManagedEndpointAllocations)
      .where(whereAllocation(input))
      .limit(1)
      .pipe(
        Effect.map((rows) => rows[0] ?? null),
        Effect.mapError(persistenceError),
      );
  });

  return ManagedEndpointAllocations.of({
    get,
    reserve: Effect.fn("relay.managed_endpoint_allocations.reserve")(function* (
      input: ReserveManagedEndpointAllocationInput,
    ) {
      return yield* entitlements.withUserLock(
        input.userId,
        Effect.gen(function* () {
          const existing = yield* get(input);
          if (existing !== null) {
            return existing;
          }
          const effective = yield* entitlements.getEffectiveForUser(input.userId);
          const allocationCounts = yield* db
            .select({ value: count() })
            .from(relayManagedEndpointAllocations)
            .where(eq(relayManagedEndpointAllocations.userId, input.userId))
            .pipe(Effect.mapError(persistenceError));
          if ((allocationCounts[0]?.value ?? 0) >= effective.managedEndpointLimit) {
            return yield* new Entitlements.UserResourceQuotaExceeded({
              resource: "managed_endpoints",
              limit: effective.managedEndpointLimit,
            });
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          const inserted = yield* db
            .insert(relayManagedEndpointAllocations)
            .values({
              ...input,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing()
            .returning(allocationSelection)
            .pipe(Effect.mapError(persistenceError));
          const allocation =
            inserted[0] ??
            (yield* db
              .select(allocationSelection)
              .from(relayManagedEndpointAllocations)
              .where(whereAllocation(input))
              .limit(1)
              .pipe(
                Effect.map((rows) => rows[0]),
                Effect.mapError(persistenceError),
              ));
          if (allocation === undefined) {
            return yield* new ManagedEndpointAllocationPersistenceError({
              cause: new Error("Managed endpoint allocation was not persisted."),
            });
          }
          return allocation;
        }),
      );
    }, Effect.mapError(reservationError)),
    recordTunnel: Effect.fn("relay.managed_endpoint_allocations.record_tunnel")(function* (
      input: RecordManagedEndpointTunnelInput,
    ) {
      yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          tunnelId: input.tunnelId,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        })
        .where(whereAllocation(input));
    }, Effect.mapError(persistenceError)),
    recordDns: Effect.fn("relay.managed_endpoint_allocations.record_dns")(function* (
      input: RecordManagedEndpointDnsInput,
    ) {
      yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          dnsRecordId: input.dnsRecordId,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        })
        .where(whereAllocation(input));
    }, Effect.mapError(persistenceError)),
    markReady: Effect.fn("relay.managed_endpoint_allocations.mark_ready")(function* (
      input: ManagedEndpointAllocationKey,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          readyAt: now,
          updatedAt: now,
        })
        .where(whereAllocation(input));
    }, Effect.mapError(persistenceError)),
    requestDeprovision: Effect.fn("relay.managed_endpoint_allocations.request_deprovision")(
      function* (input: ManagedEndpointAllocationKey) {
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* db
          .update(relayManagedEndpointAllocations)
          .set({
            deprovisionRequestedAt: now,
            updatedAt: now,
          })
          .where(whereAllocation(input));
      },
      Effect.mapError(persistenceError),
    ),
    markDeprovisionAttempt: Effect.fn(
      "relay.managed_endpoint_allocations.mark_deprovision_attempt",
    )(function* (input: ManagedEndpointAllocationKey) {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          lastDeprovisionAttemptAt: now,
          lastDeprovisionError: null,
          updatedAt: now,
        })
        .where(whereAllocation(input));
    }, Effect.mapError(persistenceError)),
    recordDeprovisionFailure: Effect.fn(
      "relay.managed_endpoint_allocations.record_deprovision_failure",
    )(function* (input: RecordManagedEndpointDeprovisionFailureInput) {
      yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          lastDeprovisionError:
            input.cause instanceof Error ? input.cause.message : String(input.cause),
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        })
        .where(whereAllocation(input));
    }, Effect.mapError(persistenceError)),
    listCleanupCandidates: Effect.fn("relay.managed_endpoint_allocations.list_cleanup_candidates")(
      function* (input) {
        return yield* db
          .select({
            userId: relayManagedEndpointAllocations.userId,
            environmentId: relayManagedEndpointAllocations.environmentId,
          })
          .from(relayManagedEndpointAllocations)
          .leftJoin(
            relayEnvironmentLinks,
            and(
              eq(relayEnvironmentLinks.userId, relayManagedEndpointAllocations.userId),
              eq(
                relayEnvironmentLinks.environmentId,
                relayManagedEndpointAllocations.environmentId,
              ),
              isNull(relayEnvironmentLinks.revokedAt),
              eq(relayEnvironmentLinks.managedTunnelsEnabled, true),
            ),
          )
          .where(
            or(
              isNotNull(relayManagedEndpointAllocations.deprovisionRequestedAt),
              and(
                isNull(relayEnvironmentLinks.userId),
                lt(relayManagedEndpointAllocations.updatedAt, input.orphanedBefore),
              ),
            ),
          );
      },
      Effect.mapError(persistenceError),
    ),
    remove: Effect.fn("relay.managed_endpoint_allocations.remove")(function* (
      input: ManagedEndpointAllocationKey,
    ) {
      yield* db.delete(relayManagedEndpointAllocations).where(whereAllocation(input));
    }, Effect.mapError(persistenceError)),
  });
});

export class ManagedEndpointAllocations extends Context.Service<
  ManagedEndpointAllocations,
  ManagedEndpointAllocationsShape
>()("t3code-relay/environments/ManagedEndpointAllocations") {
  static readonly layer = Layer.effect(this, make);
}
