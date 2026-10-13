import { describe, expect, it, vi } from "vite-plus/test";
import type { BrowserImportResult, BrowserImportSource, BrowserProfile } from "@t3tools/contracts";

import {
  runBrowserImport,
  type BrowserImportChoice,
  type BrowserProfileStore,
} from "./runBrowserImport";

const chrome: BrowserImportSource = {
  id: "chrome",
  name: "Chrome",
  profiles: [{ directory: "Default", name: "Default" }],
};

const environmentId = "env-1" as never;

function fakeBridge(result: Partial<BrowserImportResult> = {}) {
  return {
    importBrowserCookies: vi.fn(async () => ({
      imported: 3,
      skipped: 0,
      skippedDomains: [],
      ...result,
    })),
    clearCookies: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
  };
}

function fakeStore(initial: ReadonlyArray<BrowserProfile> = [], failSave = false) {
  let profiles = initial;
  const store: BrowserProfileStore = {
    current: () => profiles,
    update: async (update) => {
      const next = update(profiles);
      if (failSave) throw new Error("disk full");
      profiles = next;
      return profiles;
    },
  };
  return { store, saved: () => profiles };
}

const importInto = (
  target: BrowserImportChoice["target"],
  onImported?: (profileId: string) => void,
) => ({
  request: { source: chrome, destination: { environmentId }, onImported },
  input: { sourceProfileDirectory: "Default", target, domains: ["github.com"] },
});

describe("runBrowserImport", () => {
  it("registers a new profile named after the browser once cookies have landed in it", async () => {
    const bridge = fakeBridge();
    const { store, saved } = fakeStore([{ id: "work", name: "Chrome", kind: "persistent" }]);
    const { request, input } = importInto({ kind: "new", profileId: "p-new" });

    const outcome = await runBrowserImport(bridge, store, request, input);

    expect(outcome).toEqual({
      kind: "imported",
      imported: 3,
      skipped: 0,
      skippedDomains: [],
      targetName: "Chrome 2",
    });
    expect(saved()).toContainEqual({ id: "p-new", name: "Chrome 2", kind: "persistent" });
    expect(bridge.importBrowserCookies).toHaveBeenCalledWith({
      environmentId,
      sourceId: "chrome",
      sourceProfileDirectory: "Default",
      targetProfileId: "p-new",
      domains: ["github.com"],
    });
  });

  it("leaves no new profile behind when nothing came over", async () => {
    const { store, saved } = fakeStore();
    const { request, input } = importInto({ kind: "new", profileId: "p-new" });

    await runBrowserImport(fakeBridge({ imported: 0 }), store, request, input);

    expect(saved()).toEqual([]);
  });

  it("clears the imported cookies again when the new profile cannot be saved", async () => {
    const bridge = fakeBridge();
    const onImported = vi.fn();
    const { store } = fakeStore([], true);
    const { request, input } = importInto({ kind: "new", profileId: "p-new" }, onImported);

    const outcome = await runBrowserImport(bridge, store, request, input);

    expect(outcome).toEqual({ kind: "blocked", reason: "profileNotSaved" });
    expect(bridge.clearCookies).toHaveBeenCalledWith(environmentId, "p-new");
    expect(onImported).not.toHaveBeenCalled();
  });

  it("names the profile limit when it was reached while the import ran", async () => {
    const bridge = fakeBridge();
    const full = Array.from({ length: 24 }, (_, index) => ({
      id: `p${index}`,
      name: `Profile ${index}`,
      kind: "persistent" as const,
    }));
    const { store } = fakeStore(full);
    const { request, input } = importInto({ kind: "new", profileId: "p-new" });

    const outcome = await runBrowserImport(bridge, store, request, input);

    expect(outcome).toEqual({ kind: "blocked", reason: "profileLimitReached" });
    expect(bridge.clearCookies).toHaveBeenCalledWith(environmentId, "p-new");
  });

  it("tells the caller only when cookies were actually imported", async () => {
    const work = { id: "work", name: "Work", kind: "persistent" as const };
    const target = { kind: "existing" as const, profileId: "work", name: "Work" };

    const landed = vi.fn();
    const first = importInto(target, landed);
    await runBrowserImport(fakeBridge(), fakeStore([work]).store, first.request, first.input);
    expect(landed).toHaveBeenCalledWith("work");

    const empty = vi.fn();
    const second = importInto(target, empty);
    await runBrowserImport(
      fakeBridge({ imported: 0 }),
      fakeStore([work]).store,
      second.request,
      second.input,
    );
    expect(empty).not.toHaveBeenCalled();
  });

  it("recovers the bridge's failure reason from its flattened message", async () => {
    const bridge = fakeBridge();
    bridge.importBrowserCookies.mockRejectedValue(
      new Error("Importing cookies from chrome failed: browserRunning."),
    );
    const work = { id: "work", name: "Work", kind: "persistent" as const };
    const { request, input } = importInto({ kind: "existing", profileId: "work", name: "Work" });

    await expect(
      runBrowserImport(bridge, fakeStore([work]).store, request, input),
    ).resolves.toEqual({ kind: "blocked", reason: "browserRunning" });
  });

  it("refuses an existing profile that was removed before the import started", async () => {
    const bridge = fakeBridge();
    const { request, input } = importInto({ kind: "existing", profileId: "gone", name: "Gone" });

    const outcome = await runBrowserImport(bridge, fakeStore().store, request, input);

    expect(outcome).toEqual({ kind: "blocked", reason: "readFailed" });
    expect(bridge.importBrowserCookies).not.toHaveBeenCalled();
  });
});
