import type {
  RelayManagedEndpoint,
  RelayManagedEndpointOrigin,
  RelayManagedEndpointRuntimeConfig,
} from "@t3tools/contracts/relay";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as RelayConfiguration from "../Config.ts";

export class ManagedEndpointProvisioningNotConfigured extends Data.TaggedError(
  "ManagedEndpointProvisioningNotConfigured",
)<{}> {}

export class ManagedEndpointProvisioningFailed extends Data.TaggedError(
  "ManagedEndpointProvisioningFailed",
)<{
  readonly cause: unknown;
}> {}

export class ManagedEndpointOriginNotAllowed extends Data.TaggedError(
  "ManagedEndpointOriginNotAllowed",
)<{
  readonly host: string;
  readonly port: number;
}> {}

export type ManagedEndpointProviderError =
  | ManagedEndpointProvisioningNotConfigured
  | ManagedEndpointProvisioningFailed
  | ManagedEndpointOriginNotAllowed;

export interface ManagedEndpointProvisioningResult {
  readonly endpoint: RelayManagedEndpoint;
  readonly runtime: RelayManagedEndpointRuntimeConfig;
}

export interface ManagedEndpointProviderShape {
  readonly provision: (input: {
    readonly environmentId: string;
    readonly origin: RelayManagedEndpointOrigin;
  }) => Effect.Effect<ManagedEndpointProvisioningResult, ManagedEndpointProviderError>;
}

export class ManagedEndpointProvider extends Context.Service<
  ManagedEndpointProvider,
  ManagedEndpointProviderShape
>()("t3code-relay/environments/ManagedEndpointProvider") {}

interface ManagedEndpointTunnel {
  readonly id?: string | null;
  readonly name?: string | null;
}

export class ManagedEndpointTunnelClientError extends Data.TaggedError(
  "ManagedEndpointTunnelClientError",
)<{
  readonly cause: unknown;
}> {}

export interface ManagedEndpointTunnelClientShape {
  readonly list: (request: {
    readonly name: string;
    readonly isDeleted: false;
  }) => Effect.Effect<
    { readonly result: ReadonlyArray<ManagedEndpointTunnel> },
    ManagedEndpointTunnelClientError
  >;
  readonly create: (request: {
    readonly name: string;
    readonly configSrc: "cloudflare";
  }) => Effect.Effect<ManagedEndpointTunnel, ManagedEndpointTunnelClientError>;
  readonly putConfiguration: (
    tunnelId: string,
    config: {
      readonly ingress: Array<{
        readonly hostname?: string;
        readonly service: string;
      }>;
    },
  ) => Effect.Effect<unknown, ManagedEndpointTunnelClientError>;
  readonly getToken: (tunnelId: string) => Effect.Effect<string, ManagedEndpointTunnelClientError>;
}

export class ManagedEndpointTunnelClient extends Context.Service<
  ManagedEndpointTunnelClient,
  ManagedEndpointTunnelClientShape
>()("t3code-relay/environments/ManagedEndpointProvider/ManagedEndpointTunnelClient") {}

const CloudflareDnsRecordResponse = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.optionalKey(Schema.Unknown),
});

const CloudflareDnsRecordListResponse = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.optionalKey(Schema.Unknown),
  result: Schema.Array(
    Schema.Struct({
      id: Schema.String,
    }),
  ),
});

const requireCloudflareSettings = Effect.fnUntraced(function* (
  settings: RelayConfiguration.RelayConfigurationShape,
) {
  if (
    !settings.managedEndpointBaseDomain ||
    !settings.cloudflareZoneId ||
    !settings.cloudflareApiToken
  ) {
    return yield* new ManagedEndpointProvisioningNotConfigured();
  }
  return {
    zoneId: settings.cloudflareZoneId,
    apiToken: Redacted.value(settings.cloudflareApiToken),
    baseDomain: settings.managedEndpointBaseDomain,
  };
});

const MANAGED_ENDPOINT_HOST_PREFIX = "tunnels";
const DNS_LABEL_MAX_LENGTH = 63;
const MANAGED_ENDPOINT_HASH_LENGTH = 16;
const MANAGED_ENDPOINT_SAFE_ID_LENGTH =
  DNS_LABEL_MAX_LENGTH - MANAGED_ENDPOINT_HOST_PREFIX.length - 2 - MANAGED_ENDPOINT_HASH_LENGTH;

function managedHostname(environmentId: string, baseDomain: string, hash: string): string {
  const safeId = environmentId
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, MANAGED_ENDPOINT_SAFE_ID_LENGTH);
  const prefix = safeId.length > 0 ? safeId : "env";
  return `${MANAGED_ENDPOINT_HOST_PREFIX}-${prefix}-${hash.slice(0, MANAGED_ENDPOINT_HASH_LENGTH)}.${baseDomain.replace(/^\.+|\.+$/g, "")}`;
}

function managedTunnelName(environmentId: string, hash: string): string {
  const safeId = environmentId
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 64);
  return `t3-code-${safeId.length > 0 ? safeId : "env"}-${hash.slice(0, 16)}`;
}

function formatOriginService(origin: RelayManagedEndpointOrigin): string {
  const host = origin.localHttpHost.includes(":")
    ? `[${origin.localHttpHost.replace(/^\[(.*)\]$/u, "$1")}]`
    : origin.localHttpHost;
  return `http://${host}:${origin.localHttpPort}`;
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, "$1");
}

function isLoopbackOrigin(origin: RelayManagedEndpointOrigin): boolean {
  const hostname = normalizeHostname(origin.localHttpHost);
  return (
    (hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost") &&
    Number.isInteger(origin.localHttpPort) &&
    origin.localHttpPort > 0 &&
    origin.localHttpPort <= 65_535
  );
}

const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const tunnels = yield* ManagedEndpointTunnelClient;

  const executeJson =
    <A extends { readonly success: boolean }>(schema: Schema.Codec<A, unknown, never, unknown>) =>
    (request: HttpClientRequest.HttpClientRequest) =>
      httpClient.execute(request).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
        Effect.mapError((cause) => new ManagedEndpointProvisioningFailed({ cause })),
        Effect.filterMapOrFail(
          (body) => (body.success ? Result.succeed(body) : Result.fail(body)),
          (cause) => new ManagedEndpointProvisioningFailed({ cause }),
        ),
      );

  return ManagedEndpointProvider.of({
    provision: Effect.fn("relay.managed_endpoint_provider.provision")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.environmentId,
        "relay.managed_endpoint.origin_host": input.origin.localHttpHost,
        "relay.managed_endpoint.origin_port": input.origin.localHttpPort,
      });
      if (!isLoopbackOrigin(input.origin)) {
        return yield* new ManagedEndpointOriginNotAllowed({
          host: input.origin.localHttpHost,
          port: input.origin.localHttpPort,
        });
      }
      const cf = yield* requireCloudflareSettings(config);
      const environmentHash = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(input.environmentId))
        .pipe(
          Effect.map(Encoding.encodeHex),
          Effect.mapError((cause) => new ManagedEndpointProvisioningFailed({ cause })),
        );
      const hostname = managedHostname(input.environmentId, cf.baseDomain, environmentHash);
      const tunnelName = managedTunnelName(input.environmentId, environmentHash);

      const tunnel = yield* tunnels.list({ name: tunnelName, isDeleted: false }).pipe(
        Effect.map((tunnels) => tunnels.result),
        Effect.map(Arr.findFirst((tunnel) => tunnel.name === tunnelName)),
        Effect.flatMap(
          Option.match({
            onSome: (tunnel) => Effect.succeed(tunnel),
            onNone: () => tunnels.create({ name: tunnelName, configSrc: "cloudflare" }),
          }),
        ),
        Effect.filterMapOrFail((tunnel) =>
          tunnel.id && tunnel.name
            ? Result.succeed({ id: tunnel.id, name: tunnel.name })
            : Result.fail(new ManagedEndpointProvisioningFailed({ cause: tunnel })),
        ),
        Effect.mapError((cause) => new ManagedEndpointProvisioningFailed({ cause })),
      );

      yield* tunnels
        .putConfiguration(tunnel.id, {
          ingress: [
            {
              hostname,
              service: formatOriginService(input.origin),
            },
            { service: "http_status:404" },
          ],
        })
        .pipe(Effect.mapError((cause) => new ManagedEndpointProvisioningFailed({ cause })));

      const existingDnsRecordId = yield* HttpClientRequest.make("GET")(
        "/zones/${cf.zoneId}/dns_records",
      ).pipe(
        HttpClientRequest.prependUrl("https://api.cloudflare.com/client/v4"),
        HttpClientRequest.bearerToken(cf.apiToken),
        HttpClientRequest.setUrlParams({
          type: "CNAME",
          name: hostname,
        }),
        executeJson(CloudflareDnsRecordListResponse),
        Effect.map((body) => Arr.head(body.result)),
        Effect.map(Option.map((record) => record.id)),
      );

      const upsertDnsRequest = Option.match(existingDnsRecordId, {
        onSome: (id) => HttpClientRequest.make("PUT")(`/zones/${cf.zoneId}/dns_records/${id}`),
        onNone: () => HttpClientRequest.make("POST")(`/zones/${cf.zoneId}/dns_records`),
      });

      yield* upsertDnsRequest.pipe(
        HttpClientRequest.prependUrl("https://api.cloudflare.com/client/v4"),
        HttpClientRequest.bearerToken(cf.apiToken),
        HttpClientRequest.bodyJsonUnsafe({
          type: "CNAME",
          name: hostname,
          content: `${tunnel.id}.cfargotunnel.com`,
          proxied: true,
        }),
        executeJson(CloudflareDnsRecordResponse),
      );

      const connectorToken = yield* tunnels
        .getToken(tunnel.id)
        .pipe(Effect.mapError((cause) => new ManagedEndpointProvisioningFailed({ cause })));

      return {
        endpoint: {
          httpBaseUrl: `https://${hostname}/`,
          wsBaseUrl: `wss://${hostname}/ws`,
          providerKind: "cloudflare_tunnel",
        },
        runtime: {
          providerKind: "cloudflare_tunnel",
          connectorToken,
          tunnelId: tunnel.id,
          tunnelName: tunnel.name,
        },
      } satisfies ManagedEndpointProvisioningResult;
    }),
  });
});

export const layer = Layer.effect(ManagedEndpointProvider, make);
