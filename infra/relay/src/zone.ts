import * as Alchemy from "alchemy";
import { adopt } from "alchemy/AdoptPolicy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  MANAGED_ENDPOINT_ZONE_OWNER_STAGE,
  relayOwnsManagedEndpointZone,
  relayPublicDomainForStage,
} from "./deploymentConfig.ts";

function withLogicalId<Resource extends object>(resource: Resource, logicalId: string): Resource {
  return new Proxy(resource, {
    has: (target, property) => property === "LogicalId" || property in target,
    get: (target, property, receiver) =>
      property === "LogicalId" ? logicalId : Reflect.get(target, property, receiver),
  });
}

export const RelayDeploymentConfig = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const managedEndpointZoneName = yield* Config.nonEmptyString("RELAY_ZONE_NAME");
  const relayPublicDomainOverride = yield* Config.nonEmptyString("RELAY_DOMAIN").pipe(
    Config.option,
  );
  const relayPublicDomain = Option.getOrElse(relayPublicDomainOverride, () =>
    relayPublicDomainForStage(stage, managedEndpointZoneName),
  );

  return {
    stage,
    relayPublicDomain,
    relayPublicOrigin: `https://${relayPublicDomain}`,
    managedEndpointZoneName,
  };
});

export const ManagedEndpointZone = RelayDeploymentConfig.pipe(
  Effect.flatMap(({ stage, managedEndpointZoneName }) =>
    relayOwnsManagedEndpointZone(stage)
      ? Cloudflare.Zone("ManagedEndpointZone", { name: managedEndpointZoneName }).pipe(adopt(true))
      : Cloudflare.Zone.ref("ManagedEndpointZone", {
          stage: MANAGED_ENDPOINT_ZONE_OWNER_STAGE,
        }).pipe(
          // Alchemy beta's DNS binding policy uses LogicalId to derive a
          // stable SID, but Resource.ref returns a lazy output proxy.
          Effect.map((zone) => withLogicalId(zone, "ManagedEndpointZone")),
        ),
  ),
);
