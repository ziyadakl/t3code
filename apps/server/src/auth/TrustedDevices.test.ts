import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  identifyTrustedDeviceCaller,
  isAllowedTailnetDevice,
  makeWith,
  type TailnetLookup,
} from "./TrustedDevices.ts";

const SELF = "ziyads-macbook-air.tail30bf7c.ts.net.";
const NODES: Readonly<Record<string, string>> = {
  "100.124.129.103": SELF,
  "100.79.86.27": "affinity.tail30bf7c.ts.net.",
  "100.99.237.12": "srv1360790.tail30bf7c.ts.net.",
  // A node shared in from another tailnet that happens to reuse a trusted name.
  "100.101.1.1": "affinity.someone-else.ts.net.",
};
const ALLOW_LIST = ["ziyads-macbook-air", "iphone-15-pro-max", "affinity", "dell"];

const fakeRequest = (peer: string | undefined, headers: Record<string, string> = {}) =>
  ({
    headers: { host: "127.0.0.1:3773", ...headers },
    source: { socket: { remoteAddress: peer } },
  }) as never;

const servedFrom = (ip: string, extra: Record<string, string> = {}) =>
  fakeRequest("127.0.0.1", {
    host: "ziyads-macbook-air.tail30bf7c.ts.net:8443",
    "x-forwarded-for": ip,
    "x-forwarded-host": "ziyads-macbook-air.tail30bf7c.ts.net:8443",
    "x-forwarded-proto": "https",
    ...extra,
  });

function makeTrustedDevices(allowList: ReadonlyArray<string>) {
  const whoisCalls: Array<string> = [];
  const lookup: TailnetLookup = {
    whois: (ip) =>
      Effect.sync(() => {
        whoisCalls.push(ip);
        return Option.fromNullishOr(NODES[ip]);
      }),
    selfName: Effect.succeedSome(SELF),
  };
  return { service: makeWith({ allowList: Effect.succeed(allowList), lookup }), whoisCalls };
}

describe("identifyTrustedDeviceCaller", () => {
  it("uses the socket address of a direct connection and ignores its headers", () => {
    assert.deepEqual(
      identifyTrustedDeviceCaller({
        peerAddress: "100.99.237.12",
        headers: { "x-forwarded-for": "100.79.86.27", "tailscale-user-login": "a@b.c" },
      }),
      { kind: "tailnet-peer", ip: "100.99.237.12" },
    );
  });

  it("uses Serve's single X-Forwarded-For on a loopback connection", () => {
    assert.deepEqual(
      identifyTrustedDeviceCaller({
        peerAddress: "127.0.0.1",
        headers: { "x-forwarded-for": "100.79.86.27", host: "mac.ts.net:8443" },
      }),
      { kind: "tailnet-peer", ip: "100.79.86.27" },
    );
  });

  it("treats loopback with no proxy headers and a loopback Host as this machine", () => {
    for (const host of ["127.0.0.1:3773", "localhost:3773", "[::1]:3773"]) {
      assert.deepEqual(identifyTrustedDeviceCaller({ peerAddress: "::1", headers: { host } }), {
        kind: "this-machine",
      });
    }
  });

  it("refuses forged, chained, tunnelled and public loopback requests", () => {
    const refused = (headers: Record<string, string>) =>
      identifyTrustedDeviceCaller({ peerAddress: "127.0.0.1", headers }).kind;
    // A forwarded-for list is not what Serve sends.
    assert.equal(refused({ "x-forwarded-for": "100.79.86.27, 100.99.237.12" }), "untrusted");
    assert.equal(refused({ "x-forwarded-for": "" }), "untrusted");
    assert.equal(refused({ "x-forwarded-for": "not an ip" }), "untrusted");
    // Funnel is the public internet.
    assert.equal(
      refused({ "x-forwarded-for": "203.0.113.9", "tailscale-funnel-request": "?1" }),
      "untrusted",
    );
    // T3 Connect's Cloudflare tunnel also arrives on loopback.
    assert.equal(
      refused({ "x-forwarded-for": "100.79.86.27", "cf-connecting-ip": "203.0.113.9" }),
      "untrusted",
    );
    assert.equal(refused({ host: "localhost:3773", "cf-ray": "abc" }), "untrusted");
    // A Tailscale identity header without Serve's forwarded-for is forged.
    assert.equal(refused({ host: "localhost:3773", "tailscale-user-login": "a@b.c" }), "untrusted");
    // Proxied (Serve marks every request with X-Forwarded-Host) but missing
    // the forwarded-for that names the source: never fall back to "local".
    assert.equal(
      refused({ host: "localhost:3773", "x-forwarded-host": "mac.ts.net:8443" }),
      "untrusted",
    );
    // Not addressed to localhost (other proxy, DNS rebinding).
    assert.equal(refused({ host: "evil.example:3773" }), "untrusted");
    assert.equal(refused({}), "untrusted");
  });

  it("refuses a cross-site subresource but allows the app's own and navigated requests", () => {
    const site = (headers: Record<string, string>) =>
      identifyTrustedDeviceCaller({
        peerAddress: "127.0.0.1",
        headers: { host: "localhost:3773", ...headers },
      }).kind;
    // Another site's page loading us as an image, iframe or fetch.
    for (const dest of ["image", "iframe", "empty", "script"]) {
      assert.equal(site({ "sec-fetch-site": "cross-site", "sec-fetch-dest": dest }), "untrusted");
    }
    assert.equal(site({ "sec-fetch-site": "cross-site" }), "untrusted");
    // The app's own requests, a bookmark, and a link from another site.
    assert.equal(
      site({ "sec-fetch-site": "same-origin", "sec-fetch-dest": "empty" }),
      "this-machine",
    );
    assert.equal(site({ "sec-fetch-site": "none", "sec-fetch-dest": "document" }), "this-machine");
    assert.equal(
      site({ "sec-fetch-site": "cross-site", "sec-fetch-dest": "document" }),
      "this-machine",
    );
    // A non-browser client sends no Sec-Fetch headers at all.
    assert.equal(site({}), "this-machine");
  });

  it("refuses a request with no peer address", () => {
    assert.equal(
      identifyTrustedDeviceCaller({ peerAddress: undefined, headers: { host: "localhost" } }).kind,
      "untrusted",
    );
  });
});

describe("isAllowedTailnetDevice", () => {
  it("matches short names inside this machine's tailnet, case-insensitively", () => {
    assert.isTrue(
      isAllowedTailnetDevice({
        nodeName: "Affinity.tail30bf7c.ts.net.",
        selfName: SELF,
        allowList: ["AFFINITY"],
      }),
    );
  });

  it("refuses unlisted nodes, other tailnets and full-name entries", () => {
    const allowed = (nodeName: string, allowList = ALLOW_LIST) =>
      isAllowedTailnetDevice({ nodeName, selfName: SELF, allowList });
    assert.isFalse(allowed("srv1360790.tail30bf7c.ts.net."));
    assert.isFalse(allowed("affinity.someone-else.ts.net."));
    assert.isFalse(allowed("affinity.tail30bf7c.ts.net.", ["affinity.tail30bf7c.ts.net"]));
    assert.isFalse(allowed("affinity.tail30bf7c.ts.net.", []));
  });
});

describe("TrustedDevices.resolve", () => {
  it.effect("never trusts anyone and never asks tailscale when the list is empty", () =>
    Effect.gen(function* () {
      const { service, whoisCalls } = makeTrustedDevices([]);
      assert.isTrue(Option.isNone(yield* service.resolve(servedFrom("100.79.86.27"))));
      assert.isTrue(Option.isNone(yield* service.resolve(fakeRequest("127.0.0.1"))));
      assert.deepEqual(whoisCalls, []);
    }),
  );

  it.effect("allows a listed device reached through Tailscale Serve", () =>
    Effect.gen(function* () {
      const { service, whoisCalls } = makeTrustedDevices(ALLOW_LIST);
      assert.deepEqual(
        yield* service.resolve(servedFrom("100.79.86.27", { "tailscale-user-login": "z@x.y" })),
        Option.some("affinity"),
      );
      assert.deepEqual(whoisCalls, ["100.79.86.27"]);
    }),
  );

  it.effect("allows this machine over loopback and over its own Serve URL", () =>
    Effect.gen(function* () {
      const { service } = makeTrustedDevices(ALLOW_LIST);
      assert.deepEqual(
        yield* service.resolve(fakeRequest("127.0.0.1")),
        Option.some("ziyads-macbook-air"),
      );
      assert.deepEqual(
        yield* service.resolve(servedFrom("100.124.129.103")),
        Option.some("ziyads-macbook-air"),
      );
    }),
  );

  it.effect("denies unlisted, foreign-tailnet and unknown devices", () =>
    Effect.gen(function* () {
      const { service } = makeTrustedDevices(ALLOW_LIST);
      assert.isTrue(Option.isNone(yield* service.resolve(servedFrom("100.99.237.12"))));
      assert.isTrue(Option.isNone(yield* service.resolve(servedFrom("100.101.1.1"))));
      assert.isTrue(Option.isNone(yield* service.resolve(servedFrom("100.64.9.9"))));
      assert.isTrue(Option.isNone(yield* service.resolve(fakeRequest("192.168.1.5"))));
    }),
  );

  it.effect("ignores headers that claim a trusted device on a direct connection", () =>
    Effect.gen(function* () {
      const { service, whoisCalls } = makeTrustedDevices(ALLOW_LIST);
      const forged = fakeRequest("100.99.237.12", {
        "x-forwarded-for": "100.79.86.27",
        "tailscale-user-login": "ziyad@example.com",
      });
      assert.isTrue(Option.isNone(yield* service.resolve(forged)));
      assert.deepEqual(whoisCalls, ["100.99.237.12"]);
    }),
  );

  it.effect("denies a listed device when another site's page triggered the request", () =>
    Effect.gen(function* () {
      const { service, whoisCalls } = makeTrustedDevices(ALLOW_LIST);
      const embedded = servedFrom("100.79.86.27", {
        "sec-fetch-site": "cross-site",
        "sec-fetch-dest": "image",
      });
      assert.isTrue(Option.isNone(yield* service.resolve(embedded)));
      assert.deepEqual(whoisCalls, []);
    }),
  );

  it.effect("fails closed when tailscale cannot name this machine", () =>
    Effect.gen(function* () {
      const service = makeWith({
        allowList: Effect.succeed(ALLOW_LIST),
        lookup: {
          whois: () => Effect.succeedSome("affinity.tail30bf7c.ts.net."),
          selfName: Effect.succeedNone,
        },
      });
      assert.isTrue(Option.isNone(yield* service.resolve(servedFrom("100.79.86.27"))));
      assert.isTrue(Option.isNone(yield* service.resolve(fakeRequest("127.0.0.1"))));
    }),
  );
});
