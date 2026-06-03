import { describe, expect, it } from "@effect/vitest";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { getRelayClientStatus, installRelayClient } from "./relayClient.ts";

const available = {
  status: "available",
  executablePath: "/Users/test/.t3/tools/cloudflared/cloudflared",
  source: "managed",
  version: RelayClient.CLOUDFLARED_VERSION,
} as const;

describe("Desktop relay client IPC", () => {
  it.effect("reads status and delegates installation to the shared manager", () =>
    Effect.gen(function* () {
      const installed: Array<boolean> = [];
      const layer = Layer.succeed(
        RelayClient.RelayClient,
        RelayClient.RelayClient.of({
          resolve: Effect.succeed({
            status: "missing",
            version: RelayClient.CLOUDFLARED_VERSION,
          }),
          install: Effect.sync(() => {
            installed.push(true);
            return available;
          }),
        }),
      );

      expect(yield* getRelayClientStatus.handler(undefined).pipe(Effect.provide(layer))).toEqual({
        status: "missing",
        version: RelayClient.CLOUDFLARED_VERSION,
      });
      expect(yield* installRelayClient.handler(undefined).pipe(Effect.provide(layer))).toEqual(
        available,
      );
      expect(installed).toEqual([true]);
    }),
  );
});
