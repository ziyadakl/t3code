import * as Config from "effect/Config";

declare const __T3CODE_BUILD_T3_RELAY_URL__: string | undefined;

function normalizeRelayUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

export const buildTimeRelayUrl =
  typeof __T3CODE_BUILD_T3_RELAY_URL__ === "undefined"
    ? ""
    : normalizeRelayUrl(__T3CODE_BUILD_T3_RELAY_URL__);

export function makeRelayUrlConfig(fallback = buildTimeRelayUrl) {
  const runtimeConfig = Config.nonEmptyString("T3_RELAY_URL");
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.map(normalizeRelayUrl),
  );
}

export const relayUrlConfig = makeRelayUrlConfig();

export const hasRelayPublicConfig = Boolean(
  normalizeRelayUrl(process.env.T3_RELAY_URL ?? "") || buildTimeRelayUrl,
);
