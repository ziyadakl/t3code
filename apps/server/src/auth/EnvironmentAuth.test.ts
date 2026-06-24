import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthAdministrativeScopes } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { ServerConfigShape } from "../config.ts";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";

import * as ServerSecretStore from "./ServerSecretStore.ts";

const makeServerConfigLayer = (overrides?: Partial<ServerConfigShape>) =>
  Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      return {
        ...config,
        ...overrides,
      } satisfies ServerConfigShape;
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-server-test-" })));

const makeEnvironmentAuthLayer = (overrides?: Partial<ServerConfigShape>) =>
  EnvironmentAuth.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(makeServerConfigLayer(overrides)),
  );

const makeCookieRequest = (
  sessionToken: string,
): Parameters<EnvironmentAuth.EnvironmentAuthShape["authenticateHttpRequest"]>[0] =>
  ({
    cookies: {
      t3_session: sessionToken,
    },
    headers: {},
  }) as unknown as Parameters<EnvironmentAuth.EnvironmentAuthShape["authenticateHttpRequest"]>[0];

const makeTailscaleRequest = (
  headers: Record<string, string>,
): Parameters<EnvironmentAuth.EnvironmentAuthShape["authenticateHttpRequest"]>[0] =>
  ({
    cookies: {},
    headers,
  }) as unknown as Parameters<EnvironmentAuth.EnvironmentAuthShape["authenticateHttpRequest"]>[0];

const requestMetadata = {
  deviceType: "desktop" as const,
  os: "macOS",
  browser: "Chrome",
  ipAddress: "192.168.1.23",
};

it.layer(NodeServices.layer)("EnvironmentAuth.layer", (it) => {
  it.effect("classifies invalid bootstrap credential failures for the HTTP boundary", () =>
    Effect.sync(() => {
      const error = EnvironmentAuth.toBootstrapExchangeError(
        new PairingGrantStore.BootstrapCredentialInvalidError({
          message: "Unknown bootstrap credential.",
        }),
      );

      expect(error._tag).toBe("ServerAuthInvalidCredentialError");
      if (error._tag === "ServerAuthInvalidCredentialError") {
        expect(error.reason).toBe("invalid_credential");
      }
    }),
  );

  it.effect("maps unexpected bootstrap failures to 500", () =>
    Effect.sync(() => {
      const error = EnvironmentAuth.toBootstrapExchangeError(
        new PairingGrantStore.BootstrapCredentialInternalError({
          message: "Failed to consume bootstrap credential.",
          cause: new Error("sqlite is unavailable"),
        }),
      );

      expect(error._tag).toBe("ServerAuthInternalError");
      expect(error.message).toBe("Failed to validate bootstrap credential.");
    }),
  );

  it.effect("issues standard pairing credentials by default", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;

      const pairingCredential = yield* serverAuth.issuePairingCredential();
      const exchanged = yield* serverAuth.createBrowserSession(
        pairingCredential.credential,
        requestMetadata,
      );
      const verified = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(exchanged.sessionToken),
      );

      expect(verified.sessionId.length).toBeGreaterThan(0);
      expect(verified.scopes).toEqual([
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
      ]);
      expect(verified.subject).toBe("one-time-token");
    }).pipe(Effect.provide(makeEnvironmentAuthLayer())),
  );

  it.effect("auto-issues a trusted session for a tailnet request when trust-tailscale is on", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;

      const issued = yield* serverAuth.autoIssueTrustedSession(
        makeTailscaleRequest({ "tailscale-user-login": "ziyad@example.com" }),
        requestMetadata,
      );

      expect(Option.isSome(issued)).toBe(true);
      const value = Option.getOrThrow(issued);
      expect(value.response.authenticated).toBe(true);
      expect(value.response.sessionMethod).toBe("browser-session-cookie");
      expect(value.sessionToken.length).toBeGreaterThan(0);
      // tailnet trust grants standard client scopes only — NOT access-management admin
      expect(value.response.scopes).toContain("orchestration:operate");
      expect(value.response.scopes).not.toContain("access:write");

      // the issued cookie authenticates subsequent requests, with a tailnet subject
      const verified = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(value.sessionToken),
      );
      expect(verified.subject).toBe("tailscale:ziyad@example.com");
    }).pipe(Effect.provide(makeEnvironmentAuthLayer({ trustTailscale: true }))),
  );

  it.effect("does not auto-issue a trusted session when trust-tailscale is off", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const issued = yield* serverAuth.autoIssueTrustedSession(
        makeTailscaleRequest({ "tailscale-user-login": "ziyad@example.com" }),
        requestMetadata,
      );
      expect(Option.isNone(issued)).toBe(true);
    }).pipe(Effect.provide(makeEnvironmentAuthLayer())),
  );

  it.effect("does not auto-issue a trusted session without a tailnet identity header", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const issued = yield* serverAuth.autoIssueTrustedSession(
        makeTailscaleRequest({}),
        requestMetadata,
      );
      expect(Option.isNone(issued)).toBe(true);
    }).pipe(Effect.provide(makeEnvironmentAuthLayer({ trustTailscale: true }))),
  );

  it.effect("auto-issues a trusted session for a loopback request when trust-loopback is on", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;

      const issued = yield* serverAuth.autoIssueTrustedSession(makeTailscaleRequest({}), {
        ...requestMetadata,
        ipAddress: "127.0.0.1",
      });

      expect(Option.isSome(issued)).toBe(true);
      const value = Option.getOrThrow(issued);
      expect(value.response.scopes).toContain("orchestration:operate");
      expect(value.response.scopes).not.toContain("access:write");

      const verified = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(value.sessionToken),
      );
      expect(verified.subject).toBe("loopback");
    }).pipe(Effect.provide(makeEnvironmentAuthLayer({ trustLoopback: true }))),
  );

  it.effect("does not auto-issue for a non-loopback origin when only trust-loopback is on", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const issued = yield* serverAuth.autoIssueTrustedSession(makeTailscaleRequest({}), {
        ...requestMetadata,
        ipAddress: "192.168.1.23",
      });
      expect(Option.isNone(issued)).toBe(true);
    }).pipe(Effect.provide(makeEnvironmentAuthLayer({ trustLoopback: true }))),
  );

  it.effect("does not auto-issue a loopback request when trust-loopback is off", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const issued = yield* serverAuth.autoIssueTrustedSession(makeTailscaleRequest({}), {
        ...requestMetadata,
        ipAddress: "127.0.0.1",
      });
      expect(Option.isNone(issued)).toBe(true);
    }).pipe(Effect.provide(makeEnvironmentAuthLayer())),
  );

  it.effect("auto-issues a trusted bearer for a tailnet attach when trust-tailscale is on", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;

      const issued = yield* serverAuth.autoIssueTrustedAccessToken(
        makeTailscaleRequest({ "tailscale-user-login": "ziyad@example.com" }),
        requestMetadata,
      );

      expect(Option.isSome(issued)).toBe(true);
      const value = Option.getOrThrow(issued);
      expect(value.token_type).toBe("Bearer");
      // tailnet trust grants standard client scopes only — NOT access-management admin
      expect(value.scope).toContain("orchestration:operate");
      expect(value.scope).not.toContain("access:write");
      expect(value.expires_in).toBeGreaterThan(0);
    }).pipe(Effect.provide(makeEnvironmentAuthLayer({ trustTailscale: true }))),
  );

  it.effect("auto-issues a trusted bearer for a loopback attach when trust-loopback is on", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;

      const issued = yield* serverAuth.autoIssueTrustedAccessToken(makeTailscaleRequest({}), {
        ...requestMetadata,
        ipAddress: "127.0.0.1",
      });

      expect(Option.isSome(issued)).toBe(true);
      const value = Option.getOrThrow(issued);
      expect(value.token_type).toBe("Bearer");
      expect(value.scope).toContain("orchestration:operate");
      expect(value.scope).not.toContain("access:write");
      expect(value.expires_in).toBeGreaterThan(0);
    }).pipe(Effect.provide(makeEnvironmentAuthLayer({ trustLoopback: true }))),
  );

  it.effect("does not auto-issue a trusted bearer for an untrusted origin", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const issued = yield* serverAuth.autoIssueTrustedAccessToken(makeTailscaleRequest({}), {
        ...requestMetadata,
        ipAddress: "192.168.1.23",
      });
      expect(Option.isNone(issued)).toBe(true);
    }).pipe(Effect.provide(makeEnvironmentAuthLayer({ trustTailscale: true }))),
  );

  it.effect("does not auto-issue a trusted bearer when trust flags are off", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const issued = yield* serverAuth.autoIssueTrustedAccessToken(
        makeTailscaleRequest({ "tailscale-user-login": "ziyad@example.com" }),
        requestMetadata,
      );
      expect(Option.isNone(issued)).toBe(true);
    }).pipe(Effect.provide(makeEnvironmentAuthLayer())),
  );

  it.effect("does not exchange ordinary pairing grants for administrative access tokens", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const pairingCredential = yield* serverAuth.issuePairingCredential();

      const error = yield* serverAuth
        .exchangeBootstrapCredentialForAccessToken(
          pairingCredential.credential,
          ["orchestration:read", "access:write"],
          requestMetadata,
        )
        .pipe(Effect.flip);

      expect(error._tag).toBe("ServerAuthInvalidRequestError");
      if (error._tag === "ServerAuthInvalidRequestError") {
        expect(error.reason).toBe("scope_not_granted");
      }
    }).pipe(Effect.provide(makeEnvironmentAuthLayer())),
  );

  it.effect("inherits a constrained pairing grant when token exchange omits scope", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const pairingCredential = yield* serverAuth.issuePairingCredential({
        scopes: ["orchestration:read"],
      });

      const token = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        pairingCredential.credential,
        undefined,
        requestMetadata,
      );

      expect(token.scope).toBe("orchestration:read");
    }).pipe(Effect.provide(makeEnvironmentAuthLayer())),
  );

  it.effect("keeps user-issued administrative pairing links manageable", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const pairingCredential = yield* serverAuth.issuePairingCredential({
        scopes: AuthAdministrativeScopes,
      });
      const listedPairingLinks = yield* serverAuth.listPairingLinks();

      expect(
        listedPairingLinks.find((pairingLink) => pairingLink.id === pairingCredential.id)?.subject,
      ).toBe("one-time-token");
    }).pipe(Effect.provide(makeEnvironmentAuthLayer())),
  );

  it.effect("issues startup pairing URLs that bootstrap administrative sessions", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;

      const pairingUrl = yield* serverAuth.issueStartupPairingUrl("http://127.0.0.1:3773");
      const token = new URLSearchParams(new URL(pairingUrl).hash.slice(1)).get("token");
      const listedPairingLinks = yield* serverAuth.listPairingLinks();
      expect(token).toBeTruthy();
      expect(
        listedPairingLinks.some(
          (pairingLink) => pairingLink.subject === "administrative-bootstrap",
        ),
      ).toBe(false);

      const exchanged = yield* serverAuth.createBrowserSession(token ?? "", requestMetadata);
      const verified = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(exchanged.sessionToken),
      );

      expect(verified.scopes).toEqual([
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
        "access:read",
        "access:write",
        "relay:write",
      ]);
      expect(verified.subject).toBe("administrative-bootstrap");
    }).pipe(Effect.provide(makeEnvironmentAuthLayer())),
  );

  it.effect(
    "lists pairing links and revokes other sessions while keeping the administrative session",
    () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;

        const administrativeExchange = yield* serverAuth.createBrowserSession(
          "desktop-bootstrap-token",
          requestMetadata,
        );
        const administrativeSession = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(administrativeExchange.sessionToken),
        );
        const pairingCredential = yield* serverAuth.issuePairingCredential({
          label: "Julius iPhone",
        });
        const listedPairingLinks = yield* serverAuth.listPairingLinks();
        const clientExchange = yield* serverAuth.createBrowserSession(
          pairingCredential.credential,
          {
            ...requestMetadata,
            deviceType: "mobile",
            os: "iOS",
            browser: "Safari",
            ipAddress: "192.168.1.88",
          },
        );
        const clientSession = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(clientExchange.sessionToken),
        );
        const clientsBeforeRevoke = yield* serverAuth.listClientSessions(
          administrativeSession.sessionId,
        );
        const revokedCount = yield* serverAuth.revokeOtherClientSessions(
          administrativeSession.sessionId,
        );
        const clientsAfterRevoke = yield* serverAuth.listClientSessions(
          administrativeSession.sessionId,
        );

        expect(listedPairingLinks.map((entry) => entry.id)).toContain(pairingCredential.id);
        expect(listedPairingLinks.find((entry) => entry.id === pairingCredential.id)?.label).toBe(
          "Julius iPhone",
        );
        expect(clientsBeforeRevoke).toHaveLength(2);
        expect(
          clientsBeforeRevoke.find((entry) => entry.sessionId === administrativeSession.sessionId)
            ?.current,
        ).toBe(true);
        expect(
          clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.current,
        ).toBe(false);
        expect(
          clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.client
            .label,
        ).toBe("Julius iPhone");
        expect(
          clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.client
            .deviceType,
        ).toBe("mobile");
        expect(revokedCount).toBe(1);
        expect(clientsAfterRevoke).toHaveLength(1);
        expect(clientsAfterRevoke[0]?.sessionId).toBe(administrativeSession.sessionId);
      }).pipe(
        Effect.provide(
          makeEnvironmentAuthLayer({
            desktopBootstrapToken: "desktop-bootstrap-token",
          }),
        ),
      ),
  );
});
