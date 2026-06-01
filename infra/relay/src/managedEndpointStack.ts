import { adopt } from "alchemy/AdoptPolicy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";

export const RELAY_PUBLIC_DOMAIN = "t3code-relay.ineededadomain.com";
export const RELAY_PUBLIC_ORIGIN = `https://${RELAY_PUBLIC_DOMAIN}`;

export const ManagedEndpointZone = Effect.gen(function* () {
  const zone = yield* Cloudflare.Zone("ManagedEndpointZone", {
    name: "ineededadomain.com",
  }).pipe(adopt(true));

  const dnsToken = yield* Cloudflare.AccountApiToken("ManagedEndpointDNSToken", {
    name: "t3-code-relay-managed-endpoint-dns-token",
    policies: [
      {
        effect: "allow",
        permissionGroups: ["DNS Read", "DNS Write"],
        resources: zone.zoneId.pipe(
          Output.map((id) => ({
            [`com.cloudflare.api.account.zone.${id}`]: "*",
          })),
        ),
      },
    ],
  });

  return { zoneId: zone.zoneId, zoneName: zone.name, dnsToken: dnsToken.value };
});
