// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync or sign.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthSessionId,
  AuthStandardClientScopes,
  AuthTokenExchangeGrantType,
  EnvironmentAuthenticatedAuth,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { RelayClientTracer } from "@t3tools/shared/relayTracing";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { HttpServerRequest } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpRouter from "effect/http/HttpRouter";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as AuthHttp from "./http.ts";
import * as TrustedDevices from "./TrustedDevices.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const layerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(DEV_TOKEN),
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-http-test-" })));

const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(layerConfig),
);
// Caller identification is covered in TrustedDevices.test.ts; here a test
// header stands in for "TrustedDevices recognised an allow-listed device".
const layerTrustedDevicesStub = Layer.succeed(TrustedDevices.TrustedDevices, {
  resolve: (request) =>
    Effect.succeed(Option.fromNullishOr(request.headers["x-test-trusted-device"])),
});
const layerRoutes = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(AuthHttp.layer),
  Layer.provide(layerTrustedDevicesStub),
  Layer.provide(AuthHttp.layerAuthenticatedAuth),
  Layer.provideMerge(layerEnvironmentAuth),
  Layer.provide(layerConfig),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });

it.effect("sets the selected browser session cookies through the HTTP route", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(
        () =>
          [
            HttpRouter.toWebHandler(layerRoutes, { disableLogger: true }),
            HttpRouter.toWebHandler(layerRoutes, { disableLogger: true }),
          ] as const,
      ),
      ([environmentA, environmentB]) =>
        Effect.tryPromise(async () => {
          const devResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
            requestContext,
          );
          expect(devResponse.status).toBe(200);
          const devCookies = devResponse.headers.getSetCookie();
          const devCookie = devCookies.find((cookie) => cookie.startsWith("t3_dev_session_"));
          expect(devCookie).toContain("HttpOnly");
          expect(devCookie).toContain(`=${DEV_TOKEN};`);
          expect(devCookies).toContainEqual(
            expect.stringMatching(/^t3_session_[^=]*=;.*Max-Age=0/),
          );
          const devCookieHeader = devCookie?.split(";", 1)[0] ?? "";
          const environmentBSession = await environmentB.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { cookie: devCookieHeader },
            }),
            requestContext,
          );
          expect(environmentBSession.status).toBe(200);
          expect(await environmentBSession.json()).toMatchObject({ authenticated: true });

          const pairingResponse = await environmentA.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { cookie: devCookieHeader },
            ),
            requestContext,
          );
          expect(pairingResponse.status).toBe(200);
          const pairing = (await pairingResponse.json()) as { credential: string };
          const restrictedResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: pairing.credential }),
            requestContext,
          );
          expect(restrictedResponse.status).toBe(200);
          const restrictedCookies = restrictedResponse.headers.getSetCookie();
          expect(restrictedCookies).toHaveLength(1);
          expect(restrictedCookies[0]).toMatch(/^t3_session_/);
          expect(restrictedCookies[0]).not.toContain("t3_dev_session_");
        }),
      ([environmentA, environmentB]) =>
        Effect.promise(() => Promise.all([environmentA.dispose(), environmentB.dispose()])),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("exports only verified T3 Connect requests", () =>
  Effect.gen(function* () {
    const productSpans: Array<string> = [];
    const localSpans: Array<string> = [];
    const collect = (into: Array<string>) =>
      Tracer.make({
        span: (options) => {
          into.push(options.name);
          return new Tracer.NativeSpan(options);
        },
      });
    // "DPoP connect" is a T3 Connect session; any other DPoP token is rejected.
    const environmentAuth = {
      authenticateHttpRequest: (request: HttpServerRequest.HttpServerRequest) =>
        (request.headers.authorization === "DPoP forged"
          ? Effect.fail(
              new EnvironmentAuth.ServerAuthInvalidCredentialError({ diagnostic: "forged" }),
            )
          : Effect.succeed({
              sessionId: AuthSessionId.make("session-1"),
              subject:
                request.headers.authorization === "DPoP connect"
                  ? "cloud-connect"
                  : "cli-issued-session",
              method: "bearer-access-token" as const,
              scopes: ["orchestration:read" as const],
            })
        ).pipe(Effect.withSpan("EnvironmentAuth.authenticateHttpRequest")),
    } as unknown as EnvironmentAuth.EnvironmentAuth["Service"];
    const middleware = yield* Layer.build(AuthHttp.layerAuthenticatedAuth).pipe(
      Effect.provideService(EnvironmentAuth.EnvironmentAuth, environmentAuth),
      Effect.map(Context.get(EnvironmentAuthenticatedAuth)),
    );
    const handle = (authorization: string) =>
      (
        middleware as unknown as (
          effect: Effect.Effect<void>,
        ) => Effect.Effect<void, Error, HttpServerRequest.HttpServerRequest>
      )(Effect.void.pipe(Effect.withSpan("environment.handler"))).pipe(
        Effect.ignore,
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("https://environment.example.test/api/orchestration/shell", {
              headers: {
                authorization,
                traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
              },
            }),
          ),
        ),
        Effect.provideService(RelayClientTracer, Option.some(collect(productSpans))),
        Effect.withTracer(collect(localSpans)),
      );

    yield* handle("DPoP connect");
    expect(productSpans).toEqual([
      "environment.relay.request",
      "EnvironmentAuth.authenticateHttpRequest",
      "environment.handler",
    ]);
    expect(localSpans).toEqual(["EnvironmentAuth.authenticateHttpRequest"]);

    productSpans.length = 0;
    localSpans.length = 0;
    yield* handle("DPoP forged");
    expect(productSpans).toEqual([]);
    expect(localSpans).toEqual(["EnvironmentAuth.authenticateHttpRequest"]);

    localSpans.length = 0;
    yield* handle("Bearer access-token");
    expect(productSpans).toEqual([]);
    expect(localSpans).toEqual(["EnvironmentAuth.authenticateHttpRequest", "environment.handler"]);
  }).pipe(Effect.scoped),
);

it.effect("gives an allow-listed device a standard session instead of the pairing screen", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (environment) =>
        Effect.tryPromise(async () => {
          const untrusted = await environment.handler(
            new Request("http://127.0.0.1/api/auth/session"),
            requestContext,
          );
          expect(await untrusted.json()).toMatchObject({ authenticated: false });
          expect(untrusted.headers.getSetCookie()).toEqual([]);

          const trusted = await environment.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { "x-test-trusted-device": "affinity" },
            }),
            requestContext,
          );
          expect(trusted.status).toBe(200);
          const state = (await trusted.json()) as { authenticated: boolean; scopes: string[] };
          expect(state.authenticated).toBe(true);
          expect(state.scopes).toContain("orchestration:operate");
          expect(state.scopes).not.toContain("access:write");
          const cookie = trusted.headers.getSetCookie().find((c) => c.startsWith("t3_session_"));
          expect(cookie).toContain("HttpOnly");

          // The cookie alone authenticates the next request.
          const next = await environment.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { cookie: cookie?.split(";", 1)[0] ?? "" },
            }),
            requestContext,
          );
          expect(await next.json()).toMatchObject({ authenticated: true });
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

const tokenRequest = (
  subjectToken: string,
  headers?: Readonly<Record<string, string>>,
  scope?: string,
) =>
  new Request("http://127.0.0.1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({
      grant_type: AuthTokenExchangeGrantType,
      subject_token: subjectToken,
      subject_token_type: AuthEnvironmentBootstrapTokenType,
      requested_token_type: AuthAccessTokenType,
      ...(scope ? { scope } : {}),
    }).toString(),
  });

type ListedClient = {
  readonly subject: string;
  readonly method: string;
  readonly scopes: ReadonlyArray<string>;
  readonly client: { readonly label?: string };
};

// Runs requests against one fresh environment. `clients` lists sessions the
// way the connected-clients screen sees them, through the dev token.
const withEnvironment = (
  run: (environment: {
    readonly send: (request: Request) => Promise<Response>;
    readonly clients: () => Promise<ReadonlyArray<ListedClient>>;
    readonly mintPairingCode: () => Promise<string>;
  }) => Promise<void>,
) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (environment) =>
        Effect.tryPromise(() => {
          const send = (request: Request) => environment.handler(request, requestContext);
          const admin = { authorization: `Bearer ${DEV_TOKEN}` };
          return run({
            send,
            clients: async () => {
              const response = await send(
                new Request("http://127.0.0.1/api/auth/clients", { headers: admin }),
              );
              expect(response.status).toBe(200);
              return (await response.json()) as ReadonlyArray<ListedClient>;
            },
            mintPairingCode: async () => {
              const response = await send(postJson("/api/auth/pairing-token", {}, admin));
              expect(response.status).toBe(200);
              return ((await response.json()) as { credential: string }).credential;
            },
          });
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(NodeServices.layer));

it.effect("pairs an allow-listed device's app with any code", () =>
  withEnvironment(async ({ send, clients }) => {
    const response = await send(tokenRequest("ok", { "x-test-trusted-device": "iphone" }));
    expect(response.status).toBe(200);
    const token = (await response.json()) as { token_type: string; scope: string };
    expect(token.token_type).toBe("Bearer");
    expect(token.scope.split(" ")).toEqual([...AuthStandardClientScopes]);

    const trusted = (await clients()).find((c) => c.subject === "trusted-device:iphone");
    expect(trusted?.client.label).toBe("Trusted device: iphone");
    expect(trusted?.scopes).toEqual([...AuthStandardClientScopes]);
  }),
);

// The stub resolves no device without its header, which is also what an empty
// allow-list resolves to (TrustedDevices.test.ts), so this covers both.
it.effect("refuses a made-up code from a device that is not allow-listed", () =>
  withEnvironment(async ({ send, clients }) => {
    const response = await send(tokenRequest("ok"));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ _tag: "EnvironmentAuthInvalidError" });
    expect((await clients()).map((c) => c.subject)).not.toContainEqual(
      expect.stringMatching(/^trusted-device:/),
    );
  }),
);

it.effect("pairs a device that is not allow-listed with a real code, once", () =>
  withEnvironment(async ({ send, clients, mintPairingCode }) => {
    const code = await mintPairingCode();
    const first = await send(tokenRequest(code));
    expect(first.status).toBe(200);
    expect((await clients()).map((c) => c.subject)).not.toContainEqual(
      expect.stringMatching(/^trusted-device:/),
    );

    const again = await send(tokenRequest(code));
    expect(again.status).toBe(401);
  }),
);

it.effect("leaves a real code unused when an allow-listed device pairs with it", () =>
  withEnvironment(async ({ send, clients, mintPairingCode }) => {
    const code = await mintPairingCode();
    const trusted = await send(tokenRequest(code, { "x-test-trusted-device": "iphone" }));
    expect(trusted.status).toBe(200);
    expect((await clients()).map((c) => c.subject)).toContain("trusted-device:iphone");

    const later = await send(tokenRequest(code));
    expect(later.status).toBe(200);
  }),
);

const signDpopProof = (url: string) => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: publicKey.export({ format: "jwk" }),
  });
  const payload = encode({
    htm: "POST",
    htu: url,
    jti: NodeCrypto.randomUUID(),
    // The server checks iat against its real clock.
    // @effect-diagnostics-next-line globalDate:off
    iat: Math.floor(Date.now() / 1000),
  });
  const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${payload}.${signature}`;
};

it.effect("binds an allow-listed device's app token to its DPoP key", () =>
  withEnvironment(async ({ send, clients }) => {
    const response = await send(
      tokenRequest("ok", {
        "x-test-trusted-device": "iphone",
        // A web Request carries no host header, so the server sees localhost.
        dpop: signDpopProof("http://localhost/oauth/token"),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ token_type: "DPoP" });
    expect(await clients()).toContainEqual(
      expect.objectContaining({ subject: "trusted-device:iphone", method: "dpop-access-token" }),
    );
  }),
);

it.effect("narrows an allow-listed device's app token to the scopes it asks for", () =>
  withEnvironment(async ({ send }) => {
    const trusted = { "x-test-trusted-device": "iphone" };
    const narrowed = await send(tokenRequest("ok", trusted, "orchestration:read"));
    expect(await narrowed.json()).toMatchObject({ scope: "orchestration:read" });

    const beyond = await send(tokenRequest("ok", trusted, "access:write"));
    expect(beyond.status).toBe(400);
    expect(await beyond.json()).toMatchObject({ reason: "scope_not_granted" });
  }),
);
