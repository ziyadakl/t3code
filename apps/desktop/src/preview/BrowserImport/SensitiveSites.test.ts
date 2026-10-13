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

  it("leaves ordinary sites alone", () => {
    expect(sensitiveKind("github.com")).toBeUndefined();
    expect(sensitiveKind("localhost")).toBeUndefined();
  });
});
