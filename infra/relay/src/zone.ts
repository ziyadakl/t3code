import { adopt } from "alchemy/AdoptPolicy";
import * as Cloudflare from "alchemy/Cloudflare";

export const RELAY_PUBLIC_DOMAIN = "t3code-relay.ineededadomain.com";
export const RELAY_PUBLIC_ORIGIN = `https://${RELAY_PUBLIC_DOMAIN}`;

export const ManagedEndpointZone = Cloudflare.Zone("ManagedEndpointZone", {
  name: "ineededadomain.com",
}).pipe(adopt(true));
