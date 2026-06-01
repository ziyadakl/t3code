import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as RelayConfiguration from "../Config.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";

const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: {
    environment: "sandbox",
    teamId: "team-id",
    keyId: "key-id",
    privateKey: Redacted.make("private-key"),
    bundleId: "com.t3tools.t3code.dev",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  cloudMintPrivateKey: Redacted.make("cloud-private-key"),
  cloudMintPublicKey: "cloud-public-key",
  managedEndpointBaseDomain: "t3code.test",
  cloudflareZoneId: "zone-id",
  cloudflareApiToken: Redacted.make("api-token"),
});

interface TunnelCall {
  readonly operation: "list" | "create" | "putConfiguration" | "getToken";
  readonly input: unknown;
}

function makeTunnelClient(calls: TunnelCall[] = []) {
  return ManagedEndpointProvider.ManagedEndpointTunnelClient.of({
    list: (request) =>
      Effect.sync(() => {
        calls.push({ operation: "list", input: request });
        return { result: [] };
      }),
    create: (request) =>
      Effect.sync(() => {
        calls.push({ operation: "create", input: request });
        return { id: "tunnel-id", name: request.name };
      }),
    putConfiguration: (tunnelId, tunnelConfig) =>
      Effect.sync(() => {
        calls.push({ operation: "putConfiguration", input: { tunnelId, tunnelConfig } });
      }),
    getToken: (tunnelId) =>
      Effect.sync(() => {
        calls.push({ operation: "getToken", input: tunnelId });
        return "connector-token";
      }),
  });
}

function providerLayer(
  execute: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>,
  tunnelClient = makeTunnelClient(),
) {
  return ManagedEndpointProvider.layer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(Layer.succeed(RelayConfiguration.RelayConfiguration, config)),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute))),
    Layer.provide(Layer.succeed(ManagedEndpointProvider.ManagedEndpointTunnelClient, tunnelClient)),
  );
}

function decodeBody(request: HttpClientRequest.HttpClientRequest): unknown {
  return request.body._tag === "Uint8Array"
    ? JSON.parse(new TextDecoder().decode(request.body.body))
    : null;
}

function expectedManagedHostname(environmentId: string): string {
  const hash = NodeCrypto.createHash("sha256").update(environmentId).digest("hex").slice(0, 16);
  return `tunnels-env-abc-${hash}.t3code.test`;
}

function expectedManagedTunnelName(environmentId: string): string {
  const hash = NodeCrypto.createHash("sha256").update(environmentId).digest("hex").slice(0, 16);
  return `t3-code-env-abc-${hash}`;
}

function cloudflareApplicationErrorResponse(request: HttpClientRequest.HttpClientRequest) {
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      Response.json(
        {
          success: false,
          result: [],
          errors: [{ code: 10_000, message: "Cloudflare application failure" }],
        },
        { status: 200 },
      ),
    ),
  );
}

function cloudflareNonSuccessHttpResponse(request: HttpClientRequest.HttpClientRequest) {
  return Effect.succeed(
    HttpClientResponse.fromWeb(request, Response.json({ success: false }, { status: 503 })),
  );
}

describe("ManagedEndpointProvider", () => {
  it.effect("provisions a Cloudflare tunnel endpoint and connector token", () => {
    const tunnelCalls: TunnelCall[] = [];
    const calls: Array<{
      readonly method: string;
      readonly url: string;
      readonly body: unknown;
      readonly authorization: string | undefined;
    }> = [];
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        calls.push({
          method: request.method,
          url: request.url,
          body: decodeBody(request),
          authorization: request.headers.authorization,
        });
        if (request.url.includes("/dns_records?")) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ success: true, result: [] }, { status: 200 }),
          );
        }
        if (request.url.endsWith("/dns_records")) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ success: true }, { status: 200 }),
          );
        }
        throw new Error(`Unexpected DNS request: ${request.method} ${request.url}`);
      });

    return Effect.gen(function* () {
      const hostname = expectedManagedHostname("env_ABC");
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const result = yield* provider.provision({
        environmentId: "env_ABC",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      });

      expect(result).toEqual({
        endpoint: {
          httpBaseUrl: `https://${hostname}/`,
          wsBaseUrl: `wss://${hostname}/ws`,
          providerKind: "cloudflare_tunnel",
        },
        runtime: {
          providerKind: "cloudflare_tunnel",
          connectorToken: "connector-token",
          tunnelId: "tunnel-id",
          tunnelName: expectedManagedTunnelName("env_ABC"),
        },
      });
      expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
      expect(calls.every((call) => call.authorization === "Bearer api-token")).toBe(true);
      expect(tunnelCalls.map((call) => call.operation)).toEqual([
        "list",
        "create",
        "putConfiguration",
        "getToken",
      ]);
      expect(tunnelCalls[2]?.input).toMatchObject({
        tunnelConfig: {
          ingress: [
            {
              hostname,
              service: "http://127.0.0.1:3773",
            },
            { service: "http_status:404" },
          ],
        },
      });
      expect(tunnelCalls[0]?.input).toEqual({
        name: expectedManagedTunnelName("env_ABC"),
        isDeleted: false,
      });
    }).pipe(Effect.provide(providerLayer(execute, makeTunnelClient(tunnelCalls))));
  });

  it.effect(
    "normalizes unusual environment ids before using them in Cloudflare tunnel names",
    () => {
      const tunnelCalls: TunnelCall[] = [];
      const calls: Array<{
        readonly method: string;
        readonly url: string;
        readonly body: unknown;
      }> = [];
      const execute = (request: HttpClientRequest.HttpClientRequest) =>
        Effect.sync(() => {
          calls.push({
            method: request.method,
            url: request.url,
            body: decodeBody(request),
          });
          if (request.url.includes("/dns_records?")) {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ success: true, result: [] }, { status: 200 }),
            );
          }
          if (request.url.endsWith("/dns_records")) {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ success: true }, { status: 200 }),
            );
          }
          throw new Error(`Unexpected DNS request: ${request.method} ${request.url}`);
        });

      return Effect.gen(function* () {
        const environmentId = "ENV With Spaces/../Symbols!" + "x".repeat(80);
        const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
        yield* provider.provision({
          environmentId,
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
        });

        const requestedName = (
          tunnelCalls.find((call) => call.operation === "list")?.input as
            | { readonly name?: string }
            | undefined
        )?.name;
        expect(requestedName).toMatch(/^t3-code-env-with-spaces-symbols-x+-[a-f0-9]{16}$/);
        expect(requestedName?.length).toBeLessThanOrEqual(89);
        const configBody = (
          tunnelCalls.find((call) => call.operation === "putConfiguration")?.input as
            | { readonly tunnelConfig?: unknown }
            | undefined
        )?.tunnelConfig;
        expect(configBody).toMatchObject({
          ingress: [
            {
              hostname: expect.stringMatching(
                /^tunnels-env-with-spaces-symbols-x+-[a-f0-9]{16}\.t3code\.test$/,
              ),
            },
            { service: "http_status:404" },
          ],
        });
        const hostname = (
          configBody as
            | {
                readonly ingress?: readonly [{ readonly hostname?: unknown }, unknown];
              }
            | undefined
        )?.ingress?.[0]?.hostname;
        expect(
          typeof hostname === "string" ? hostname.split(".")[0]?.length : 0,
        ).toBeLessThanOrEqual(63);
        expect(tunnelCalls.find((call) => call.operation === "create")?.input).toMatchObject({
          name: requestedName,
          configSrc: "cloudflare",
        });
      }).pipe(Effect.provide(providerLayer(execute, makeTunnelClient(tunnelCalls))));
    },
  );

  it.effect("formats IPv6 loopback origins as valid Cloudflare ingress service URLs", () => {
    const tunnelCalls: TunnelCall[] = [];
    const calls: Array<{
      readonly method: string;
      readonly url: string;
      readonly body: unknown;
    }> = [];
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        calls.push({
          method: request.method,
          url: request.url,
          body: decodeBody(request),
        });
        if (request.url.includes("/dns_records?")) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ success: true, result: [] }, { status: 200 }),
          );
        }
        if (request.url.endsWith("/dns_records")) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ success: true }, { status: 200 }),
          );
        }
        throw new Error(`Unexpected DNS request: ${request.method} ${request.url}`);
      });

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision({
        environmentId: "env-ipv6",
        origin: { localHttpHost: "::1", localHttpPort: 3773 },
      });

      expect(
        tunnelCalls.find((call) => call.operation === "putConfiguration")?.input,
      ).toMatchObject({
        tunnelConfig: {
          ingress: [
            {
              service: "http://[::1]:3773",
            },
            { service: "http_status:404" },
          ],
        },
      });
    }).pipe(Effect.provide(providerLayer(execute, makeTunnelClient(tunnelCalls))));
  });

  it.effect("rejects non-loopback managed endpoint origins before calling Cloudflare", () => {
    const calls: Array<HttpClientRequest.HttpClientRequest> = [];
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        calls.push(request);
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ success: true, result: [] }, { status: 200 }),
        );
      });

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const result = yield* Effect.result(
        provider.provision({
          environmentId: "env_ABC",
          origin: { localHttpHost: "192.168.1.10", localHttpPort: 3773 },
        }),
      );

      expect(calls).toHaveLength(0);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("ManagedEndpointOriginNotAllowed");
      }
    }).pipe(Effect.provide(providerLayer(execute)));
  });

  it.effect("rejects invalid managed endpoint origin ports before calling Cloudflare", () => {
    const calls: Array<HttpClientRequest.HttpClientRequest> = [];
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        calls.push(request);
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ success: true, result: [] }, { status: 200 }),
        );
      });

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const result = yield* Effect.result(
        provider.provision({
          environmentId: "env_ABC",
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 65_536 },
        }),
      );

      expect(calls).toHaveLength(0);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("ManagedEndpointOriginNotAllowed");
      }
    }).pipe(Effect.provide(providerLayer(execute)));
  });

  it.effect("fails provisioning when Cloudflare returns a 2xx application error", () => {
    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const error = yield* Effect.flip(
        provider.provision({
          environmentId: "env_ABC",
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
        }),
      );

      expect(error._tag).toBe("ManagedEndpointProvisioningFailed");
      expect(error.cause).toMatchObject({
        success: false,
        errors: [{ message: "Cloudflare application failure" }],
      });
    }).pipe(Effect.provide(providerLayer(cloudflareApplicationErrorResponse)));
  });

  it.effect("fails provisioning when Cloudflare returns a non-success HTTP response", () => {
    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const error = yield* Effect.flip(
        provider.provision({
          environmentId: "env_ABC",
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
        }),
      );

      expect(error._tag).toBe("ManagedEndpointProvisioningFailed");
    }).pipe(Effect.provide(providerLayer(cloudflareNonSuccessHttpResponse)));
  });
});
