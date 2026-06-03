import { describe, expect, it } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import * as RateLimits from "./RateLimits.ts";

const provideWorkerEnvironment = Effect.provideService(Cloudflare.WorkerEnvironment, {});

function client(limit: Cloudflare.RateLimitClient["limit"]): Cloudflare.RateLimitClient {
  return {
    raw: Effect.die("unused raw rate limit binding"),
    limit,
  };
}

function clients(
  overrides: Partial<RateLimits.RelayRateLimitClients> = {},
): RateLimits.RelayRateLimitClients {
  const allow = client(() => Effect.succeed({ success: true }));
  return {
    token_exchange: { standard: allow, trusted: allow },
    link_challenge: { standard: allow, trusted: allow },
    managed_endpoint_provision: { standard: allow, trusted: allow },
    environment_connect: { standard: allow, trusted: allow },
    environment_status: { standard: allow, trusted: allow },
    mobile_registration: { standard: allow, trusted: allow },
    agent_activity_publish: { standard: allow, trusted: allow },
    ...overrides,
  };
}

describe("RateLimits", () => {
  it.effect("returns a typed denial when Cloudflare rejects the key", () =>
    Effect.gen(function* () {
      const rateLimits = yield* RateLimits.RateLimits;
      const error = yield* Effect.flip(
        rateLimits.check({
          operation: "environment_connect",
          key: "user-1:env-1",
        }),
      );

      expect(error).toEqual(
        new RateLimits.RelayRateLimitExceeded({
          operation: "environment_connect",
          retryAfterSeconds: 60,
        }),
      );
    }).pipe(
      provideWorkerEnvironment,
      Effect.provide(
        RateLimits.layerCloudflareBindings(
          clients({
            environment_connect: {
              standard: client(() => Effect.succeed({ success: false })),
              trusted: client(() => Effect.succeed({ success: true })),
            },
          }),
        ),
      ),
    ),
  );

  it.effect("uses the trusted binding for trusted users", () => {
    let checked = false;
    return Effect.gen(function* () {
      const rateLimits = yield* RateLimits.RateLimits;
      yield* rateLimits.check({
        operation: "link_challenge",
        key: "user-1",
        tier: "trusted",
      });
      expect(checked).toBe(true);
    }).pipe(
      provideWorkerEnvironment,
      Effect.provide(
        RateLimits.layerCloudflareBindings(
          clients({
            link_challenge: {
              standard: client(() => Effect.die("standard binding should not run")),
              trusted: client(() =>
                Effect.sync(() => {
                  checked = true;
                  return { success: true };
                }),
              ),
            },
          }),
        ),
      ),
    );
  });

  it.effect("fails open when the Cloudflare binding is unavailable", () =>
    Effect.gen(function* () {
      const rateLimits = yield* RateLimits.RateLimits;
      yield* rateLimits.check({
        operation: "agent_activity_publish",
        key: "env-1:key-1",
      });
    }).pipe(
      provideWorkerEnvironment,
      Effect.provide(
        RateLimits.layerCloudflareBindings(
          clients({
            agent_activity_publish: {
              standard: client(() =>
                Effect.fail({
                  _tag: "RateLimitError",
                  message: "binding unavailable",
                  cause: "binding unavailable",
                } as never),
              ),
              trusted: client(() => Effect.succeed({ success: true })),
            },
          }),
        ),
      ),
    ),
  );

  it.effect("always denies blocked users without calling Cloudflare", () =>
    Effect.gen(function* () {
      const rateLimits = yield* RateLimits.RateLimits;
      const error = yield* Effect.flip(
        rateLimits.check({
          operation: "mobile_registration",
          key: "user-1",
          tier: "blocked",
        }),
      );
      expect(error.operation).toBe("mobile_registration");
    }).pipe(
      provideWorkerEnvironment,
      Effect.provide(RateLimits.layerCloudflareBindings(clients())),
    ),
  );
});
