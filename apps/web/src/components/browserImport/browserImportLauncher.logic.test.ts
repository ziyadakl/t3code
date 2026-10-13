import { describe, expect, it } from "vite-plus/test";
import type { BrowserImportSource } from "@t3tools/contracts";

import {
  importFailureReason,
  importableBrowserSources,
  listSitesOutcome,
  freshBannerChoice,
  oncePerSession,
  previewImportLanded,
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
  const ready = { dismissed: false, sources: [source("chrome")] };

  it("shows while a browser is here to import from", () => {
    expect(shouldShowCookieImportBanner(ready)).toBe(true);
  });

  it("stays hidden until sources have loaded, so it never flashes in and out", () => {
    expect(shouldShowCookieImportBanner({ ...ready, sources: null })).toBe(false);
  });

  it("stays hidden once dismissed", () => {
    expect(shouldShowCookieImportBanner({ ...ready, dismissed: true })).toBe(false);
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

describe("previewImportLanded", () => {
  it("reloads the tab when the cookies landed in the profile it shows", () => {
    expect(previewImportLanded("work", "work")).toEqual({ reloadTab: true, dismissBanner: true });
  });

  it("leaves the tab alone when it moved to another profile while the import ran", () => {
    expect(previewImportLanded("work", "personal")).toEqual({
      reloadTab: false,
      dismissBanner: true,
    });
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

describe("oncePerSession", () => {
  it("lists once and hands every caller the same answer, even while it is in flight", async () => {
    let calls = 0;
    const listed = oncePerSession(async () => {
      calls += 1;
      return [source("chrome")];
    });

    const [first, second] = await Promise.all([listed(), listed()]);
    await listed();

    expect(calls).toBe(1);
    expect(second).toBe(first);
  });

  it("tries again after a failed listing instead of keeping the failure", async () => {
    let calls = 0;
    const listed = oncePerSession(async () => {
      calls += 1;
      if (calls === 1) throw new Error("bridge not ready");
      return [source("chrome")];
    });

    await expect(listed()).rejects.toThrow("bridge not ready");
    await expect(listed()).resolves.toEqual([source("chrome")]);
  });

  it("keeps listing until it finds something to keep, then stops", async () => {
    let calls = 0;
    const listed = oncePerSession(
      async () => {
        calls += 1;
        return calls === 1 ? [] : [source("chrome")];
      },
      (sources) => sources.length > 0,
    );

    await expect(listed()).resolves.toEqual([]);
    await expect(listed()).resolves.toEqual([source("chrome")]);
    await listed();

    expect(calls).toBe(2);
  });
});

describe("freshBannerChoice", () => {
  it("opens the wizard with the fresh listing of the chosen browser, not the cached one", () => {
    const fresh = { ...source("chrome", "browserRunning"), profiles: [] };
    expect(freshBannerChoice([source("safari"), fresh], "chrome")).toEqual({
      kind: "open",
      source: fresh,
    });
  });

  it("refreshes the banner instead when the chosen browser is no longer importable", () => {
    const fresh = [source("chrome", "notInstalled"), source("safari")];
    expect(freshBannerChoice(fresh, "chrome")).toEqual({ kind: "refresh", sources: fresh });
    expect(freshBannerChoice([], "chrome")).toEqual({ kind: "refresh", sources: [] });
  });
});
