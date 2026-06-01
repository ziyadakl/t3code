import { describe, expect, it } from "vitest";

import {
  MANAGED_ENDPOINT_PROVISIONER_TOKEN_POLICIES,
  MANAGED_ENDPOINT_ZONE,
} from "./ManagedEndpointStackConfig.ts";

describe("ManagedEndpointStackConfig", () => {
  it("restricts endpoint provisioning to the relay account and DNS zone", () => {
    expect(MANAGED_ENDPOINT_PROVISIONER_TOKEN_POLICIES).toEqual([
      {
        effect: "allow",
        permissionGroups: ["Cloudflare Tunnel Read", "Cloudflare Tunnel Write"],
        resources: {
          [`com.cloudflare.api.account.${MANAGED_ENDPOINT_ZONE.accountId}`]: "*",
        },
      },
      {
        effect: "allow",
        permissionGroups: ["DNS Read", "DNS Write"],
        resources: {
          [`com.cloudflare.api.account.zone.${MANAGED_ENDPOINT_ZONE.zoneId}`]: "*",
        },
      },
    ]);
  });
});
