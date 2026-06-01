import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { lt } from "drizzle-orm";

import { RelayDb } from "../db.ts";
import { relayDpopProofs } from "../schema.ts";

export class DpopProofReplayPersistenceError extends Data.TaggedError(
  "DpopProofReplayPersistenceError",
)<{
  readonly cause: unknown;
}> {}

export interface DpopProofReplayShape {
  readonly consume: (input: {
    readonly thumbprint: string;
    readonly jti: string;
    readonly iat: number;
    readonly expiresAt: DateTime.DateTime;
  }) => Effect.Effect<boolean, DpopProofReplayPersistenceError>;

  readonly pruneExpired: Effect.Effect<void, DpopProofReplayPersistenceError>;
}

export class DpopProofReplay extends Context.Service<DpopProofReplay, DpopProofReplayShape>()(
  "DpopProofReplay",
) {}

const make = Effect.gen(function* () {
  const db = yield* RelayDb;

  const consume: DpopProofReplayShape["consume"] = Effect.fn("relay.dpop_proofs.consume")(
    function* (input) {
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const inserted = yield* db
        .insert(relayDpopProofs)
        .values({
          thumbprint: input.thumbprint,
          jti: input.jti,
          iat: input.iat,
          expiresAt: DateTime.formatIso(input.expiresAt),
          createdAt,
        })
        .onConflictDoNothing()
        .returning({ jti: relayDpopProofs.jti });
      return inserted.length > 0;
    },
    Effect.mapError((cause) => new DpopProofReplayPersistenceError({ cause })),
  );

  const pruneExpired: DpopProofReplayShape["pruneExpired"] = Effect.fn(
    "relay.dpop_proofs.prune_expired",
  )(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* Effect.annotateCurrentSpan({ "relay.dpop_prune.before": now });
    yield* db.delete(relayDpopProofs).where(lt(relayDpopProofs.expiresAt, now));
  })().pipe(Effect.mapError((cause) => new DpopProofReplayPersistenceError({ cause })));

  return DpopProofReplay.of({
    consume,
    pruneExpired,
  });
});

export const layer = Layer.effect(DpopProofReplay, make);
