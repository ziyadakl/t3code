import * as Alchemy from "alchemy";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { RelayDeploymentConfig } from "./zone.ts";

describe("RelayDeploymentConfig", () => {
  it("reads the stage from the stack context available in the Worker runtime", async () => {
    const config = await Effect.runPromise(
      RelayDeploymentConfig.pipe(
        Effect.provideService(Alchemy.Stack, {
          name: "T3CodeRelay",
          stage: "dev_julius",
          bindings: {},
          resources: {},
          actions: {},
        }),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              RELAY_ZONE_NAME: "example.com",
            }),
          ),
        ),
      ),
    );

    expect(config).toEqual({
      stage: "dev_julius",
      relayPublicDomain: "relay-dev-julius.example.com",
      relayPublicOrigin: "https://relay-dev-julius.example.com",
      managedEndpointZoneName: "example.com",
    });
  });
});
