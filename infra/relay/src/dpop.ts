import { verifyDpopProof } from "@t3tools/shared/dpop";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";

import * as DpopProofs from "./persistence/DpopProofs.ts";

export const verifyAndConsumeDpopProof = Effect.fn("relay.dpop.verify_and_consume")(
  function* (input: {
    readonly proof: string | undefined;
    readonly method: string;
    readonly url: string;
    readonly expectedThumbprint?: string;
    readonly expectedAccessToken?: string;
    readonly now: DateTime.DateTime;
  }) {
    const dpopProofs = yield* DpopProofs.DpopProofReplay;
    yield* Effect.annotateCurrentSpan({
      "relay.dpop.method": input.method,
      "relay.dpop.expected_thumbprint_present": input.expectedThumbprint !== undefined,
      "relay.dpop.expected_access_token_present": input.expectedAccessToken !== undefined,
    });
    const result = verifyDpopProof({
      proof: input.proof,
      method: input.method,
      url: input.url,
      nowEpochSeconds: Math.floor(input.now.epochMilliseconds / 1_000),
      ...(input.expectedThumbprint ? { expectedThumbprint: input.expectedThumbprint } : {}),
      ...(input.expectedAccessToken ? { expectedAccessToken: input.expectedAccessToken } : {}),
    });
    if (!result.ok) {
      yield* Effect.logWarning("relay dpop proof rejected", {
        reason: result.reason,
        method: input.method,
        url: input.url,
        expectedThumbprintPresent: input.expectedThumbprint !== undefined,
        expectedAccessTokenPresent: input.expectedAccessToken !== undefined,
      });
      return yield* new HttpApiError.Unauthorized({});
    }
    const consumed = yield* dpopProofs.consume({
      thumbprint: result.thumbprint,
      jti: result.jti,
      iat: result.iat,
      expiresAt: DateTime.add(input.now, { minutes: 5 }),
    });
    if (!consumed) {
      yield* Effect.logWarning("relay dpop proof replay rejected", {
        thumbprint: result.thumbprint,
        jti: result.jti,
        iat: result.iat,
      });
      return yield* new HttpApiError.Unauthorized({});
    }
    yield* Effect.annotateCurrentSpan({
      "relay.dpop.thumbprint": result.thumbprint,
      "relay.dpop.iat": result.iat,
    });
    return result.thumbprint;
  },
);
