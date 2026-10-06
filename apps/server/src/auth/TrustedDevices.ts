/**
 * Trusted devices: browsers on an allow-listed Tailscale device skip pairing.
 *
 * The allow-list is `trustedTailscaleDevices` in the server's settings.json
 * (MagicDNS short names). Empty, the default, means every caller pairs, exactly
 * as without this module. A trusted caller gets an ordinary browser session
 * with standard client scopes, never access-management scopes.
 *
 * What is trusted, and why
 * ------------------------
 * The caller's device is decided from the TCP peer address of the request
 * (the socket, never a header), in one of three ways:
 *
 * 1. Peer is a non-loopback address. The client connected straight to the
 *    server, so every header is client-controlled and is ignored. The peer
 *    address itself goes to `tailscale whois`; tailscaled answers from its
 *    WireGuard peer map, which a client cannot spoof.
 *
 * 2. Peer is loopback and carries `X-Forwarded-For`. This is the Tailscale
 *    Serve path (HTTPS on the tailnet -> http://127.0.0.1:<port>). Serve
 *    *replaces* X-Forwarded-For with the one real source IP of the tailnet
 *    connection (`addProxyForwardedHeaders` in tailscale's
 *    ipn/ipnlocal/serve.go uses Header.Set, and httputil's Rewrite mode drops
 *    inbound X-Forwarded-* first), so a header a tailnet client sends never
 *    survives. We therefore accept exactly one IP and refuse a list, and run
 *    `tailscale whois` on it. Serve also strips client-sent `Tailscale-User-*`
 *    headers and marks Funnel (public internet) traffic with
 *    `Tailscale-Funnel-Request`, which we refuse. The `Tailscale-User-Login`
 *    header names a user, not a device, and is not used.
 *
 *    These headers are only trustworthy because the server listens on
 *    127.0.0.1: the only things that can open a loopback connection are
 *    Tailscale Serve and processes on this machine. A local process can forge
 *    X-Forwarded-For, but anything that can run code here already controls
 *    the server and its secrets, so that grants it nothing new. If the server
 *    is bound to a public interface this branch never runs (the peer is not
 *    loopback, see 1).
 *
 * 3. Peer is loopback with no proxy headers and a loopback Host. This is a
 *    browser on this machine, and counts as this machine's own Tailscale name
 *    (`tailscale status`). Any proxy marker refuses it, because other local
 *    forwarders also connect from loopback: T3 Connect's Cloudflare tunnel
 *    (Cf-Connecting-Ip, X-Forwarded-*) carries internet traffic, and a
 *    non-loopback Host (Serve, tunnels, DNS rebinding) means the request was
 *    not addressed to localhost. A same-machine forwarder that rewrites Host
 *    to localhost and adds no forwarding headers (the Vite dev proxy does
 *    this) makes its callers look local; leave the list empty on dev setups
 *    that expose such a proxy.
 *
 * A device name matches only inside this machine's own tailnet: the peer's
 * full MagicDNS name must equal `<entry>.<our tailnet suffix>`, so a node
 * shared in from another tailnet with the same short name does not match.
 * Every failure (no tailscale CLI, timeout, unknown peer) refuses trust and
 * falls back to pairing.
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

/** Decides who is calling, from the socket peer plus (only on loopback) Serve's headers. */
export function identifyTrustedDeviceCaller(request: TrustedDeviceRequest): TrustedDeviceCaller {
  const peer = request.peerAddress?.trim();
  if (!peer) return { kind: "untrusted", reason: "no-peer-address" };

  if (!isLoopbackAddress(peer)) {
    return IP_LITERAL.test(peer)
      ? { kind: "tailnet-peer", ip: peer }
      : { kind: "untrusted", reason: "unparseable-peer-address" };
  }

  const headers = request.headers;
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
