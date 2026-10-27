/**
 * Trusted devices: browsers on an allow-listed Tailscale device (`trustedTailscaleDevices` in
 * settings.json, MagicDNS short names) skip pairing; empty, the default, means every caller
 * pairs. The device is decided from the TCP peer address (the socket, never a header); the
 * peer's full MagicDNS name must equal `<entry>.<our tailnet suffix>`, else it pairs as usual.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import { ChildProcessSpawner } from "effect/process";
import { readTailscaleStatus, readTailscaleWhois } from "@t3tools/tailscale";

import { ServerSettingsService } from "../serverSettings.ts";
import { deriveAuthClientMetadata } from "./utils.ts";

export type TrustedDeviceCaller =
  | { readonly kind: "this-machine" }
  | { readonly kind: "tailnet-peer"; readonly ip: string }
  | { readonly kind: "untrusted"; readonly reason: string };

export interface TrustedDeviceRequest {
  /** The TCP peer address from the socket. */
  readonly peerAddress: string | undefined;
  /** Lowercased header names. */
  readonly headers: Readonly<Record<string, string | undefined>>;
}

// Headers some reverse proxy put there. Any of them on a loopback request
// without X-Forwarded-For means a forwarder we do not know, so we refuse.
const PROXY_MARKER_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
  "via",
  "cf-connecting-ip",
  "cf-ray",
  "tailscale-user-login",
  "tailscale-headers-info",
  "tailscale-funnel-request",
] as const;

const IP_LITERAL = /^[0-9a-f:.]+$/iu;

function isLoopbackAddress(address: string): boolean {
  return address === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(address);
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname.replace(/^\[(.*)\]$/u, "$1");
    return hostname === "localhost" || isLoopbackAddress(hostname);
  } catch {
    return false;
  }
}

function present(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

/**
 * True unless the browser says this is a cross-site subresource load (image, iframe, script
 * or fetch on another site's page), which could make this GET mint sessions that pile up in
 * the user's list. Page scripts cannot override `Sec-Fetch-Site`; no header means a non-browser client.
 */
function isUserVisibleRequest(headers: TrustedDeviceRequest["headers"]): boolean {
  const site = headers["sec-fetch-site"]?.trim().toLowerCase();
  if (site === undefined || site.length === 0) return true;
  if (site === "same-origin" || site === "same-site" || site === "none") return true;
  // A cross-site top-level navigation is the user opening the app from a link.
  return headers["sec-fetch-dest"]?.trim().toLowerCase() === "document";
}

/** Decides who is calling, from the socket peer plus (only on loopback) Serve's headers. */
export function identifyTrustedDeviceCaller(request: TrustedDeviceRequest): TrustedDeviceCaller {
  const peer = request.peerAddress?.trim();
  if (!peer) return { kind: "untrusted", reason: "no-peer-address" };

  if (!isUserVisibleRequest(request.headers)) {
    return { kind: "untrusted", reason: "cross-site-subresource" };
  }

  // Non-loopback peer: the client connected straight to the server, so every header is
  // client-controlled and ignored. The peer address goes to `tailscale whois`, answered from
  // tailscaled's WireGuard peer map, which a client cannot spoof.
  if (!isLoopbackAddress(peer)) {
    return IP_LITERAL.test(peer)
      ? { kind: "tailnet-peer", ip: peer }
      : { kind: "untrusted", reason: "unparseable-peer-address" };
  }

  const headers = request.headers;
  // Loopback peer: only Tailscale Serve and local processes can connect, which is why Serve's
  // headers are trustworthy; a local process could forge them but already controls the server.
  // Serve replaces X-Forwarded-For with the one real source IP and strips client-sent
  // `Tailscale-User-*`; Funnel (public internet) traffic is marked and refused.
  if (present(headers["tailscale-funnel-request"])) {
    return { kind: "untrusted", reason: "tailscale-funnel" };
  }
  if (present(headers["cf-connecting-ip"]) || present(headers["cf-ray"])) {
    return { kind: "untrusted", reason: "cloudflare-tunnel" };
  }

  const forwardedFor = headers["x-forwarded-for"];
  if (forwardedFor !== undefined) {
    const ip = forwardedFor.trim();
    // Serve sets exactly one address; a list means some other proxy chain.
    if (ip.length === 0 || ip.includes(",") || !IP_LITERAL.test(ip)) {
      return { kind: "untrusted", reason: "unexpected-forwarded-for" };
    }
    return { kind: "tailnet-peer", ip };
  }

  // No forwarding headers and a loopback Host: a browser on this machine. Any proxy marker or
  // non-loopback Host refuses it; a forwarder that rewrites Host to localhost (the Vite dev
  // proxy) makes its callers look local, so leave the list empty on dev setups exposing one.
  if (PROXY_MARKER_HEADERS.some((name) => present(headers[name]))) {
    return { kind: "untrusted", reason: "unknown-proxy" };
  }
  if (!isLoopbackHost(headers.host)) {
    return { kind: "untrusted", reason: "non-loopback-host" };
  }
  return { kind: "this-machine" };
}

function normalizeDnsName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/u, "");
}

/**
 * True when `nodeName` (a full MagicDNS name) is one of the allow-listed
 * devices in the tailnet that `selfName` (this machine's MagicDNS name) is in.
 */
export function isAllowedTailnetDevice(input: {
  readonly nodeName: string;
  readonly selfName: string;
  readonly allowList: ReadonlyArray<string>;
}): boolean {
  const node = normalizeDnsName(input.nodeName);
  const self = normalizeDnsName(input.selfName);
  const dot = self.indexOf(".");
  if (dot <= 0) return false;
  const tailnetSuffix = self.slice(dot + 1);
  return input.allowList.some((entry) => {
    const name = normalizeDnsName(entry);
    return name.length > 0 && !name.includes(".") && node === `${name}.${tailnetSuffix}`;
  });
}

export interface TailnetLookup {
  /** Full MagicDNS name of the node that owns `ip`, or none. */
  readonly whois: (ip: string) => Effect.Effect<Option.Option<string>>;
  /** Full MagicDNS name of this machine, or none. */
  readonly selfName: Effect.Effect<Option.Option<string>>;
}

export class TrustedDevices extends Context.Service<
  TrustedDevices,
  {
    /** The allow-listed device name of the caller, or none (pair as usual). */
    readonly resolve: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<Option.Option<string>>;
  }
>()("t3/auth/TrustedDevices") {}

export const makeWith = (input: {
  readonly allowList: Effect.Effect<ReadonlyArray<string>>;
  readonly lookup: TailnetLookup;
}): TrustedDevices["Service"] => ({
  resolve: Effect.fn("TrustedDevices.resolve")(function* (request) {
    const allowList = yield* input.allowList;
    if (allowList.length === 0) return Option.none();

    const caller = identifyTrustedDeviceCaller({
      peerAddress: deriveAuthClientMetadata({ request }).ipAddress,
      headers: request.headers,
    });
    if (caller.kind === "untrusted") return Option.none();

    const selfName = yield* input.lookup.selfName;
    if (Option.isNone(selfName)) return Option.none();
    const nodeName =
      caller.kind === "this-machine" ? selfName : yield* input.lookup.whois(caller.ip);
    if (Option.isNone(nodeName)) return Option.none();

    return isAllowedTailnetDevice({
      nodeName: nodeName.value,
      selfName: selfName.value,
      allowList,
    })
      ? Option.some(normalizeDnsName(nodeName.value).split(".")[0]!)
      : Option.none();
  }),
});

export const layer = Layer.effect(
  TrustedDevices,
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const provideSpawner = Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner);
    return makeWith({
      allowList: settings.getSettings.pipe(
        Effect.map((current) => current.trustedTailscaleDevices),
        Effect.orElseSucceed(() => []),
      ),
      lookup: {
        whois: (ip) =>
          readTailscaleWhois(ip).pipe(
            Effect.map((whois) => Option.some(whois.nodeName)),
            Effect.orElseSucceed(() => Option.none()),
            provideSpawner,
          ),
        selfName: readTailscaleStatus.pipe(
          Effect.map((status) => Option.fromNullishOr(status.magicDnsName)),
          Effect.orElseSucceed(() => Option.none()),
          provideSpawner,
        ),
      },
    });
  }),
);
