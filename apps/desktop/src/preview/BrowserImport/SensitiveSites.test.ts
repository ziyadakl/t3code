import { describe, expect, it } from "@effect/vitest";

import { sensitiveKind } from "./SensitiveSites.ts";

describe("sensitiveKind", () => {
  it("flags mail, sign-in and money sites by registrable domain", () => {
    expect(sensitiveKind("outlook.com")).toBe("email");
    expect(sensitiveKind("proton.me")).toBe("email");
    // Google is mail too, but its session signs in to everything else first.
    expect(sensitiveKind("google.com")).toBe("signIn");
    expect(sensitiveKind("1password.com")).toBe("signIn");
    expect(sensitiveKind("paypal.com")).toBe("banking");
    expect(sensitiveKind("coinbase.com")).toBe("banking");
  });

  it("treats any domain named for a bank as banking", () => {
    expect(sensitiveKind("tdbank.com")).toBe("banking");
    expect(sensitiveKind("bankofireland.ie")).toBe("banking");
  });

  it("flags a brand's country domains, not look-alike names", () => {
    expect(sensitiveKind("google.co.uk")).toBe("signIn");
    expect(sensitiveKind("google.de")).toBe("signIn");
    expect(sensitiveKind("yahoo.co.jp")).toBe("email");
    expect(sensitiveKind("live.fr")).toBe("email");
    expect(sensitiveKind("googleblog.com")).toBeUndefined();
    expect(sensitiveKind("notgoogle.co.uk")).toBeUndefined();
    expect(sensitiveKind("olive.com")).toBeUndefined();
    expect(sensitiveKind("outlookindia.com")).toBeUndefined();
  });

  it("does not take a user's page on a hosting suffix for the brand", () => {
    expect(sensitiveKind("live.blogspot.com")).toBeUndefined();
    expect(sensitiveKind("google.blogspot.com")).toBeUndefined();
    expect(sensitiveKind("someone.github.io")).toBeUndefined();
  });

  it("flags the sign-in-with identity providers", () => {
    expect(sensitiveKind("github.com")).toBe("signIn");
    expect(sensitiveKind("facebook.com")).toBe("signIn");
    expect(sensitiveKind("x.com")).toBe("signIn");
    expect(sensitiveKind("twitter.com")).toBe("signIn");
  });

  it("leaves ordinary sites alone", () => {
    expect(sensitiveKind("example.com")).toBeUndefined();
    expect(sensitiveKind("localhost")).toBeUndefined();
  });
});
