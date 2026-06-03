import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { RelayAgentActivityState as RelayAgentActivityStateSchema } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { cast } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { and, count, desc, eq, isNull } from "drizzle-orm";

import { RelayDb } from "../db.ts";
import { relayAgentActivityRows, relayEnvironmentLinks } from "../persistence/schema.ts";

export class AgentActivityRowUpsertPersistenceError extends Data.TaggedError(
  "AgentActivityRowUpsertPersistenceError",
)<{
  readonly cause: unknown;
}> {}

export class AgentActivityRowDeletePersistenceError extends Data.TaggedError(
  "AgentActivityRowDeletePersistenceError",
)<{
  readonly cause: unknown;
}> {}

export class AgentActivityRowListPersistenceError extends Data.TaggedError(
  "AgentActivityRowListPersistenceError",
)<{
  readonly cause: unknown;
}> {}

export class AgentActivityRowQuotaExceeded extends Data.TaggedError(
  "AgentActivityRowQuotaExceeded",
)<{
  readonly resource: "active_agent_threads";
  readonly limit: number;
}> {}

const MAX_ACTIVE_AGENT_THREADS_PER_ENVIRONMENT = 50;

export interface AgentActivityRowsShape {
  readonly upsert: (input: {
    readonly environmentPublicKey: string;
    readonly state: RelayAgentActivityState;
  }) => Effect.Effect<void, AgentActivityRowUpsertPersistenceError | AgentActivityRowQuotaExceeded>;
  readonly remove: (input: {
    readonly environmentId: string;
    readonly environmentPublicKey: string;
    readonly threadId: string;
  }) => Effect.Effect<void, AgentActivityRowDeletePersistenceError>;
  readonly listForUser: (input: {
    readonly userId: string;
  }) => Effect.Effect<ReadonlyArray<RelayAgentActivityState>, AgentActivityRowListPersistenceError>;
}

export class AgentActivityRows extends Context.Service<AgentActivityRows, AgentActivityRowsShape>()(
  "t3code-relay/agentActivity/AgentActivityRows",
) {}

const decodeJsonString = Schema.decodeEffect(Schema.UnknownFromJsonString);
const encodeJsonValue = Schema.encodeEffect(Schema.UnknownFromJsonString);

const encodeRelayAgentActivityStateJson = Schema.encodeEffect(
  Schema.fromJsonString(RelayAgentActivityStateSchema),
);

const decodeRelayAgentActivityStateJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAgentActivityStateSchema),
);

const make = Effect.gen(function* () {
  const db = yield* RelayDb;

  return AgentActivityRows.of({
    upsert: Effect.fn("relay.agent_activity_rows.upsert")(
      function* (input) {
        yield* Effect.annotateCurrentSpan({
          "relay.environment_id": input.state.environmentId,
          "relay.thread_id": input.state.threadId,
        });
        const now = yield* DateTime.now;
        const stateJson = yield* encodeRelayAgentActivityStateJson(input.state).pipe(
          Effect.flatMap(decodeJsonString),
          Effect.map(cast<unknown, RelayAgentActivityState>),
        );
        yield* db.$client.withTransaction(
          Effect.gen(function* () {
            yield* db.$client`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.state.environmentId}:${input.environmentPublicKey}`}, 1))`;
            const keyCondition = and(
              eq(relayAgentActivityRows.environmentId, input.state.environmentId),
              eq(relayAgentActivityRows.environmentPublicKey, input.environmentPublicKey),
            );
            const existing = yield* db
              .select({ threadId: relayAgentActivityRows.threadId })
              .from(relayAgentActivityRows)
              .where(and(keyCondition, eq(relayAgentActivityRows.threadId, input.state.threadId)))
              .limit(1);
            if (existing.length === 0) {
              const rows = yield* db
                .select({ value: count() })
                .from(relayAgentActivityRows)
                .where(keyCondition);
              if ((rows[0]?.value ?? 0) >= MAX_ACTIVE_AGENT_THREADS_PER_ENVIRONMENT) {
                return yield* new AgentActivityRowQuotaExceeded({
                  resource: "active_agent_threads",
                  limit: MAX_ACTIVE_AGENT_THREADS_PER_ENVIRONMENT,
                });
              }
            }
            yield* db
              .insert(relayAgentActivityRows)
              .values({
                environmentId: input.state.environmentId,
                environmentPublicKey: input.environmentPublicKey,
                threadId: input.state.threadId,
                stateJson,
                updatedAt: input.state.updatedAt,
                createdAt: DateTime.formatIso(now),
              })
              .onConflictDoUpdate({
                target: [
                  relayAgentActivityRows.environmentId,
                  relayAgentActivityRows.environmentPublicKey,
                  relayAgentActivityRows.threadId,
                ],
                set: {
                  stateJson,
                  updatedAt: input.state.updatedAt,
                },
              });
          }),
        );
      },
      Effect.mapError((cause) =>
        cause instanceof AgentActivityRowQuotaExceeded
          ? cause
          : new AgentActivityRowUpsertPersistenceError({ cause }),
      ),
    ),

    remove: Effect.fn("relay.agent_activity_rows.remove")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.environmentId,
        "relay.thread_id": input.threadId,
      });
      yield* db
        .delete(relayAgentActivityRows)
        .where(
          and(
            eq(relayAgentActivityRows.environmentId, input.environmentId),
            eq(relayAgentActivityRows.environmentPublicKey, input.environmentPublicKey),
            eq(relayAgentActivityRows.threadId, input.threadId),
          ),
        )
        .pipe(Effect.mapError((cause) => new AgentActivityRowDeletePersistenceError({ cause })));
    }),

    listForUser: Effect.fn("relay.agent_activity_rows.list_for_user")(function* (input) {
      return yield* db
        .select({ stateJson: relayAgentActivityRows.stateJson })
        .from(relayAgentActivityRows)
        .innerJoin(
          relayEnvironmentLinks,
          and(
            eq(relayEnvironmentLinks.environmentId, relayAgentActivityRows.environmentId),
            eq(
              relayEnvironmentLinks.environmentPublicKey,
              relayAgentActivityRows.environmentPublicKey,
            ),
          ),
        )
        .where(
          and(
            eq(relayEnvironmentLinks.userId, input.userId),
            isNull(relayEnvironmentLinks.revokedAt),
            eq(relayEnvironmentLinks.liveActivitiesEnabled, true),
          ),
        )
        .orderBy(desc(relayAgentActivityRows.updatedAt))
        .pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) => encodeJsonValue(row.stateJson), {
              concurrency: "unbounded",
            }),
          ),
          Effect.map((rows) =>
            rows.flatMap((row) => Option.toArray(decodeRelayAgentActivityStateJson(row))),
          ),
          Effect.mapError((cause) => new AgentActivityRowListPersistenceError({ cause })),
        );
    }),
  });
});

export const layer = Layer.effect(AgentActivityRows, make);
