import { clerkFrontendApiUrlFromPublishableKey } from "@t3tools/shared/relayAuth";
import * as Config from "effect/Config";

declare const __T3CODE_BUILD_RELAY_URL__: string | undefined;
declare const __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: string | undefined;
declare const __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__: string | undefined;

const CLOUD_CLI_OAUTH_REDIRECT_URI = "http://127.0.0.1:34338/callback";
const CLOUD_CLI_OAUTH_SCOPES = ["openid", "profile", "email"] as const;

function normalizeRelayUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

function readBuildTimeValue(value: string | undefined): string {
  return typeof value === "undefined" ? "" : value.trim();
}

export const buildTimeRelayUrl =
  typeof __T3CODE_BUILD_RELAY_URL__ === "undefined"
    ? ""
    : normalizeRelayUrl(__T3CODE_BUILD_RELAY_URL__);
export const buildTimeClerkPublishableKey = readBuildTimeValue(
  typeof __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__,
);
export const buildTimeClerkCliOAuthClientId = readBuildTimeValue(
  typeof __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__,
);

export function makeRelayUrlConfig(fallback = buildTimeRelayUrl) {
  const runtimeConfig = Config.nonEmptyString("T3CODE_RELAY_URL");
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.map(normalizeRelayUrl),
  );
}

export const relayUrlConfig = makeRelayUrlConfig();

function makePublicValueConfig(name: string, fallback: string) {
  const runtimeConfig = Config.nonEmptyString(name);
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.map((value) => value.trim()),
  );
}

export interface CloudCliOAuthConfig {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: typeof CLOUD_CLI_OAUTH_SCOPES;
}

export function makeCloudCliOAuthConfig({
  clerkPublishableKeyFallback = buildTimeClerkPublishableKey,
  clerkCliOAuthClientIdFallback = buildTimeClerkCliOAuthClientId,
}: {
  readonly clerkPublishableKeyFallback?: string;
  readonly clerkCliOAuthClientIdFallback?: string;
} = {}) {
  return Config.all({
    clerkPublishableKey: makePublicValueConfig(
      "T3CODE_CLERK_PUBLISHABLE_KEY",
      clerkPublishableKeyFallback,
    ),
    clientId: makePublicValueConfig(
      "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
      clerkCliOAuthClientIdFallback,
    ),
  }).pipe(
    Config.map(({ clerkPublishableKey, clientId }) => {
      const clerkFrontendApiUrl = clerkFrontendApiUrlFromPublishableKey(clerkPublishableKey);
      return {
        authorizationEndpoint: `${clerkFrontendApiUrl}/oauth/authorize`,
        tokenEndpoint: `${clerkFrontendApiUrl}/oauth/token`,
        clientId,
        redirectUri: CLOUD_CLI_OAUTH_REDIRECT_URI,
        scopes: CLOUD_CLI_OAUTH_SCOPES,
      } satisfies CloudCliOAuthConfig;
    }),
  );
}

export const cloudCliOAuthConfig = makeCloudCliOAuthConfig();

export const hasCloudPublicConfig = Boolean(
  (normalizeRelayUrl(process.env.T3CODE_RELAY_URL ?? "") || buildTimeRelayUrl) &&
  (process.env.T3CODE_CLERK_PUBLISHABLE_KEY?.trim() || buildTimeClerkPublishableKey) &&
  (process.env.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID?.trim() || buildTimeClerkCliOAuthClientId),
);
