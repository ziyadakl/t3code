import { describe, expect, it } from "vite-plus/test";

import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import { isAllowedTailscaleLogin, readTailscaleIdentity } from "./TailscaleTrust.ts";

const requestWithHeaders = (headers: Record<string, string>): HttpServerRequest.HttpServerRequest =>
  ({ headers }) as never;

describe("readTailscaleIdentity", () => {
  it("returns the identity when the login header is present", () => {
    const identity = readTailscaleIdentity(
      requestWithHeaders({
        "tailscale-user-login": "alice@example.com",
      }),
    );

    expect(identity).toEqual({ login: "alice@example.com" });
  });

  it("includes name and profilePic when present and non-empty", () => {
    const identity = readTailscaleIdentity(
      requestWithHeaders({
        "tailscale-user-login": "alice@example.com",
        "tailscale-user-name": "Alice Example",
        "tailscale-user-profile-pic": "https://example.com/alice.png",
      }),
    );

    expect(identity).toEqual({
      login: "alice@example.com",
      name: "Alice Example",
      profilePic: "https://example.com/alice.png",
    });
  });

  it("trims surrounding whitespace from header values", () => {
    const identity = readTailscaleIdentity(
      requestWithHeaders({
        "tailscale-user-login": "  alice@example.com  ",
        "tailscale-user-name": "  Alice Example  ",
      }),
    );

    expect(identity).toEqual({
      login: "alice@example.com",
      name: "Alice Example",
    });
  });

  it("omits name and profilePic when they are empty or whitespace", () => {
    const identity = readTailscaleIdentity(
      requestWithHeaders({
        "tailscale-user-login": "alice@example.com",
        "tailscale-user-name": "   ",
        "tailscale-user-profile-pic": "",
      }),
    );

    expect(identity).toEqual({ login: "alice@example.com" });
  });

  it("returns undefined when the login header is missing", () => {
    const identity = readTailscaleIdentity(
      requestWithHeaders({
        "tailscale-user-name": "Alice Example",
      }),
    );

    expect(identity).toBeUndefined();
  });

  it("returns undefined when the login header is empty or whitespace", () => {
    expect(
      readTailscaleIdentity(requestWithHeaders({ "tailscale-user-login": "" })),
    ).toBeUndefined();
    expect(
      readTailscaleIdentity(requestWithHeaders({ "tailscale-user-login": "   " })),
    ).toBeUndefined();
  });
});

describe("isAllowedTailscaleLogin", () => {
  it("allows any tailnet identity when there is no allowlist", () => {
    expect(isAllowedTailscaleLogin("alice@example.com")).toBe(true);
    expect(isAllowedTailscaleLogin("alice@example.com", undefined)).toBe(true);
    expect(isAllowedTailscaleLogin("alice@example.com", [])).toBe(true);
  });

  it("allows a login that matches the allowlist (case-insensitive)", () => {
    expect(isAllowedTailscaleLogin("Alice@Example.com", ["alice@example.com"])).toBe(true);
    expect(
      isAllowedTailscaleLogin("alice@example.com", ["bob@example.com", "ALICE@EXAMPLE.COM"]),
    ).toBe(true);
  });

  it("rejects a login that is not in the allowlist", () => {
    expect(
      isAllowedTailscaleLogin("carol@example.com", ["alice@example.com", "bob@example.com"]),
    ).toBe(false);
  });

  it("rejects an empty or whitespace login", () => {
    expect(isAllowedTailscaleLogin("")).toBe(false);
    expect(isAllowedTailscaleLogin("   ")).toBe(false);
    expect(isAllowedTailscaleLogin("   ", ["alice@example.com"])).toBe(false);
  });
});
