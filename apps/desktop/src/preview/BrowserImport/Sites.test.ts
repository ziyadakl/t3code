import { describe, expect, it } from "@effect/vitest";

import { groupSites, siteDomain } from "./Sites.ts";

describe("siteDomain", () => {
  it("groups subdomains and domain cookies under the registrable domain", () => {
    expect(siteDomain(".google.com")).toBe("google.com");
    expect(siteDomain("mail.google.com")).toBe("google.com");
    expect(siteDomain("www.bbc.co.uk")).toBe("bbc.co.uk");
  });
});

describe("groupSites", () => {
  it("counts a site's cookies across its hosts", () => {
    const sites = groupSites(
      [
        {
          host: ".example.com",
          secure: false,
          httpOnly: false,
          expiresAt: undefined,
          lastAccessedAt: undefined,
        },
        {
          host: "docs.example.com",
          secure: false,
          httpOnly: false,
          expiresAt: undefined,
          lastAccessedAt: undefined,
        },
      ],
      { now: 0 },
    );
    expect(sites).toEqual([
      { domain: "example.com", cookieCount: 2, signedIn: false, current: false },
    ]);
  });

  const NOW = 1_800_000_000_000;
  const session = {
    secure: true,
    httpOnly: true,
    expiresAt: 1_900_000_000,
    lastAccessedAt: undefined,
  };

  it("calls a site signed in only for a live HttpOnly, Secure, persistent cookie", () => {
    const sites = groupSites(
      [
        { host: "signed.test", ...session },
        { host: "notsecure.test", ...session, secure: false },
        { host: "script.test", ...session, httpOnly: false },
        { host: "tab.test", ...session, expiresAt: undefined },
        { host: "stale.test", ...session, expiresAt: 1_700_000_000 },
      ],
      { now: NOW },
    );
    expect(Object.fromEntries(sites.map((site) => [site.domain, site.signedIn]))).toEqual({
      "notsecure.test": false,
      "script.test": false,
      "signed.test": true,
      "tab.test": false,
    });
  });

  it("leaves expired cookies out of the count", () => {
    const sites = groupSites(
      [
        { host: "a.test", ...session },
        { host: "a.test", ...session, expiresAt: 1_700_000_000 },
      ],
      { now: NOW },
    );
    expect(sites.map((site) => site.cookieCount)).toEqual([1]);
  });

  it("reports the most recent access, and omits it when the store keeps none", () => {
    const sites = groupSites(
      [
        { host: "a.test", ...session, lastAccessedAt: 100 },
        { host: "www.a.test", ...session, lastAccessedAt: 300 },
        { host: "b.test", ...session },
      ],
      { now: NOW },
    );
    expect(sites.find((site) => site.domain === "a.test")?.lastAccessedAt).toBe(300);
    expect(sites.find((site) => site.domain === "b.test")).not.toHaveProperty("lastAccessedAt");
  });

  it("marks the site the preview tab is showing", () => {
    const cookies = [
      { host: ".github.com", ...session },
      { host: "example.com", ...session },
    ];
    const current = (currentUrl: string | undefined) =>
      groupSites(cookies, { now: NOW, currentUrl })
        .filter((site) => site.current)
        .map((site) => site.domain);
    expect(current("https://gist.github.com/x")).toEqual(["github.com"]);
    expect(current("about:blank")).toEqual([]);
    expect(current("not a url")).toEqual([]);
    expect(current(undefined)).toEqual([]);
  });

  it("tags sensitive sites and leaves ordinary ones untagged", () => {
    const sites = groupSites(
      [
        { host: "mail.google.com", ...session },
        { host: "example.com", ...session },
      ],
      { now: NOW },
    );
    expect(sites.find((site) => site.domain === "google.com")?.sensitive).toBe("signIn");
    expect(sites.find((site) => site.domain === "example.com")).not.toHaveProperty("sensitive");
  });

  it("keeps hosts without a public suffix as their own site", () => {
    expect(siteDomain("localhost")).toBe("localhost");
    expect(siteDomain("127.0.0.1")).toBe("127.0.0.1");
  });
});
