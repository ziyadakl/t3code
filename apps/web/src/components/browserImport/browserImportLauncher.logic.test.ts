import { describe, expect, it } from "vite-plus/test";
import type { BrowserImportSource } from "@t3tools/contracts";

import {
  importFailureReason,
  importableBrowserSources,
  listSitesOutcome,
  shouldShowCookieImportBanner,
  singleImportableSource,
} from "./browserImportLauncher.logic";

const source = (
  id: BrowserImportSource["id"],
  unavailable?: BrowserImportSource["unavailable"],
): BrowserImportSource => ({
  id,
  name: id,
  profiles: [{ directory: "Default", name: "Default" }],
  ...(unavailable === undefined ? {} : { unavailable }),
});

describe("importableBrowserSources", () => {
  it("leaves out browsers that are not here or can never be read, keeps every fixable one", () => {
    const sources = [
      source("chrome"),
      source("edge", "notInstalled"),
      source("arc", "browserRunning"),
      source("brave", "unsupportedPlatform"),
      source("safari", "needsFullDiskAccess"),
    ];
    expect(importableBrowserSources(sources).map((s) => s.id)).toEqual(["chrome", "arc", "safari"]);
  });
});

describe("shouldShowCookieImportBanner", () => {
  const ready = {
    importSupported: true,
    profilePersistent: true,
    dismissed: false,
    sources: [source("chrome")],
  };

  it("shows when the desktop can import into a persistent profile and a browser is here", () => {
    expect(shouldShowCookieImportBanner(ready)).toBe(true);
  });

  it("stays hidden until sources have loaded, so it never flashes in and out", () => {
    expect(shouldShowCookieImportBanner({ ...ready, sources: null })).toBe(false);
  });

  it("stays hidden once dismissed, in incognito, or where this machine's browsers are out of reach", () => {
    expect(shouldShowCookieImportBanner({ ...ready, dismissed: true })).toBe(false);
    expect(shouldShowCookieImportBanner({ ...ready, profilePersistent: false })).toBe(false);
    expect(shouldShowCookieImportBanner({ ...ready, importSupported: false })).toBe(false);
  });

  it("stays hidden when no browser can be imported from", () => {
    expect(
      shouldShowCookieImportBanner({
        ...ready,
        sources: [source("edge", "notInstalled"), source("chrome", "unsupportedPlatform")],
      }),
    ).toBe(false);
  });

  it("still shows for a browser that needs a step first, such as quitting it", () => {
    expect(
      shouldShowCookieImportBanner({ ...ready, sources: [source("arc", "browserRunning")] }),
    ).toBe(true);
  });
});

// Mirrors `BrowserImportFailedError.message`, which IPC flattens to a string
// before the renderer sees it.
const failure = (reason: string) => ({
  message: `Importing cookies from safari failed: ${reason}.`,
});

describe("importFailureReason", () => {
  it("recovers the reason token from the flattened message", () => {
    expect(importFailureReason(failure("needsFullDiskAccess"))).toBe("needsFullDiskAccess");
    expect(importFailureReason(failure("browserRunning"))).toBe("browserRunning");
    expect(importFailureReason(failure("readFailed"))).toBe("readFailed");
    expect(importFailureReason(failure("keychainUnavailable"))).toBe("keychainUnavailable");
    // A settings write that fails after the cookies landed is its own case,
    // not a read failure over a database that was in fact read.
    expect(importFailureReason(failure("profileNotSaved"))).toBe("profileNotSaved");
    expect(importFailureReason(failure("profileLimitReached"))).toBe("profileLimitReached");
  });

  it("falls back to readFailed for anything it cannot classify", () => {
    expect(importFailureReason(new Error("something else entirely"))).toBe("readFailed");
    expect(importFailureReason(undefined)).toBe("readFailed");
  });
});

describe("listSitesOutcome", () => {
  const site = {
    domain: "github.com",
    cookieCount: 12,
    signedIn: true,
    current: false,
  };

  it("hands the listed sites through", async () => {
    await expect(listSitesOutcome(Promise.resolve([site]))).resolves.toEqual({
      kind: "sites",
      sites: [site],
    });
  });

  it("classifies a failed listing exactly as a failed import", async () => {
    await expect(listSitesOutcome(Promise.reject(failure("needsFullDiskAccess")))).resolves.toEqual(
      { kind: "blocked", reason: "needsFullDiskAccess" },
    );
    await expect(listSitesOutcome(Promise.reject(new Error("boom")))).resolves.toEqual({
      kind: "blocked",
      reason: "readFailed",
    });
  });
});

describe("singleImportableSource", () => {
  it("names the one browser to import from, so the banner can skip the choice", () => {
    expect(singleImportableSource([source("edge", "notInstalled"), source("safari")])?.id).toBe(
      "safari",
    );
  });

  it("is absent when there is a real choice to make", () => {
    expect(singleImportableSource([source("chrome"), source("safari")])).toBeUndefined();
    expect(singleImportableSource([])).toBeUndefined();
  });
});
