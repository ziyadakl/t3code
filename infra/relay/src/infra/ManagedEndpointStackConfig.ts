export const MANAGED_ENDPOINT_ZONE = {
  name: "ineededadomain.com",
  zoneId: "fcea40a6915723b0f5c4a9480eb3507b",
  accountId: "1468bbd99811cdaccfbb707dc725421a",
} as const;

export const RELAY_PUBLIC_DOMAIN = `t3code-relay.${MANAGED_ENDPOINT_ZONE.name}`;
export const RELAY_PUBLIC_ORIGIN = `https://${RELAY_PUBLIC_DOMAIN}`;
export const MANAGED_ENDPOINT_BASE_DOMAIN = MANAGED_ENDPOINT_ZONE.name;

export const MANAGED_ENDPOINT_PROVISIONER_TOKEN_POLICIES = [
  {
    effect: "allow" as const,
    permissionGroups: ["Cloudflare Tunnel Read" as const, "Cloudflare Tunnel Write" as const],
    resources: {
      [`com.cloudflare.api.account.${MANAGED_ENDPOINT_ZONE.accountId}`]: "*",
    },
  },
  {
    effect: "allow" as const,
    permissionGroups: ["DNS Read" as const, "DNS Write" as const],
    resources: {
      [`com.cloudflare.api.account.zone.${MANAGED_ENDPOINT_ZONE.zoneId}`]: "*",
    },
  },
];
