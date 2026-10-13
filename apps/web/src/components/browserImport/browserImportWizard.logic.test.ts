import { describe, expect, it } from "vite-plus/test";
import type { BrowserImportSite, BrowserImportSource } from "@t3tools/contracts";

import {
  canCloseWizard,
  filterSites,
  siteBulkActionLabels,
  capSiteRows,
  initialWizardStep,
  initialSiteSelection,
  orderSites,
  initialTargetSelection,
  isRetryableReason,
  blockedRetryAction,
  formatSkippedDomains,
  fullDiskAccessRecheckStep,
  outcomeToStep,
  refreshedSourceProfileDirectory,
  refreshedSourceStep,
  resolveWizardTarget,
  selectedImportDomains,
  siteSelectionFor,
  sitesOutcomeToStep,
} from "./browserImportWizard.logic";

describe("wizard target selection", () => {
  it("treats an existing profile whose id is new as an existing target", () => {
    const profiles = [{ id: "new", name: "Existing new" }];
    const selection = initialTargetSelection(false, profiles);

    expect(selection).toEqual({ kind: "existing", profileId: "new" });
    expect(resolveWizardTarget(selection, "generated", profiles)).toEqual({
      kind: "existing",
      profileId: "new",
      name: "Existing new",
    });
  });

  it("starts on the profile the preview tab is showing", () => {
    const profiles = [
      { id: "default", name: "Default" },
      { id: "work", name: "Work" },
    ];
    expect(initialTargetSelection(true, profiles, "work")).toEqual({
      kind: "existing",
      profileId: "work",
    });
  });

  it("ignores a requested profile that is not a target", () => {
    const profiles = [{ id: "default", name: "Default" }];
    expect(initialTargetSelection(true, profiles, "incognito")).toEqual({ kind: "new" });
    expect(initialTargetSelection(false, profiles, "incognito")).toEqual({
      kind: "existing",
      profileId: "default",
    });
  });

  it("fixes a locked target to the requested profile, even once it is gone", () => {
    const profiles = [{ id: "default", name: "Default" }];
    expect(initialTargetSelection(true, profiles, "work", true)).toEqual({
      kind: "existing",
      profileId: "work",
    });
    expect(
      resolveWizardTarget({ kind: "existing", profileId: "work" }, "generated", profiles),
    ).toBeUndefined();
  });

  it("rejects an existing target that is no longer listed", () => {
    expect(
      resolveWizardTarget({ kind: "existing", profileId: "removed" }, "generated", [
        { id: "default", name: "Default" },
      ]),
    ).toBeUndefined();
  });
});

const source = (over: Partial<BrowserImportSource> = {}): BrowserImportSource => ({
  id: "helium",
  name: "Helium",
  profiles: [{ directory: "Default", name: "You" }],
  ...over,
});

describe("initialWizardStep", () => {
  it("opens on the quit screen when the browser is running", () => {
    expect(initialWizardStep(source({ unavailable: "browserRunning" }))).toEqual({ step: "quit" });
  });

  it("opens on configure when the source is ready", () => {
    expect(initialWizardStep(source())).toEqual({ step: "configure" });
  });

  it("asks for Full Disk Access before choosing an import target", () => {
    expect(initialWizardStep(source({ profiles: [], unavailable: "needsFullDiskAccess" }))).toEqual(
      {
        step: "fullDiskAccess",
        resume: "configure",
      },
    );
  });

  it("blocks on a reason nothing local can fix", () => {
    expect(initialWizardStep(source({ unavailable: "unsupportedPlatform" }))).toEqual({
      step: "blocked",
      reason: "unsupportedPlatform",
    });
  });

  it("blocks a ready source that reports no importable profiles", () => {
    expect(initialWizardStep(source({ profiles: [] }))).toEqual({
      step: "blocked",
      reason: "unknownSourceProfile",
    });
  });

  it("handles source availability before checking its profiles", () => {
    expect(
      initialWizardStep(source({ profiles: [], unavailable: "needsKeychainApproval" })),
    ).toEqual({ step: "blocked", reason: "needsKeychainApproval" });
  });
});

describe("canCloseWizard", () => {
  it("keeps the wizard open while an import writes its target profile", () => {
    expect(canCloseWizard({ step: "importing" })).toBe(false);
    expect(canCloseWizard({ step: "configure" })).toBe(true);
    expect(canCloseWizard({ step: "blocked", reason: "readFailed" })).toBe(true);
  });
});

describe("outcomeToStep", () => {
  it("lands on done after a successful import", () => {
    expect(
      outcomeToStep({
        kind: "imported",
        imported: 12,
        skipped: 3,
        skippedDomains: ["example.com"],
        targetName: "Work",
      }),
    ).toEqual({
      step: "done",
      imported: 12,
      skipped: 3,
      skippedDomains: ["example.com"],
      targetName: "Work",
    });
  });

  it("routes a reopened browser back to the quit screen", () => {
    expect(outcomeToStep({ kind: "blocked", reason: "browserRunning" })).toEqual({ step: "quit" });
  });

  it("routes a Full Disk Access refusal to its own screen", () => {
    expect(outcomeToStep({ kind: "blocked", reason: "needsFullDiskAccess" })).toEqual({
      step: "fullDiskAccess",
      resume: "import",
      checked: true,
    });
  });

  it("surfaces every other failure on the blocked screen, retrying the import", () => {
    expect(outcomeToStep({ kind: "blocked", reason: "readFailed" })).toEqual({
      step: "blocked",
      reason: "readFailed",
      retry: "import",
    });
  });
});

describe("refreshedSourceStep", () => {
  it("moves to configure once a quit browser frees its cookies", () => {
    expect(refreshedSourceStep(source())).toEqual({ step: "configure" });
  });

  it("stays on quit while the browser is still running", () => {
    expect(refreshedSourceStep(source({ unavailable: "browserRunning" }))).toEqual({
      step: "quit",
    });
  });

  it("blocks when the source vanished from the list", () => {
    expect(refreshedSourceStep(undefined)).toEqual({ step: "blocked", reason: "unknownSource" });
  });

  it("blocks when the refreshed source has no profiles", () => {
    expect(refreshedSourceStep(source({ profiles: [] }))).toEqual({
      step: "blocked",
      reason: "unknownSourceProfile",
    });
  });
});

describe("fullDiskAccessRecheckStep", () => {
  it("marks a still-denied access check for visible feedback", () => {
    expect(fullDiskAccessRecheckStep(source({ unavailable: "needsFullDiskAccess" }))).toEqual({
      step: "fullDiskAccess",
      resume: "configure",
      checked: true,
    });
  });

  it("moves on once access reveals the source profiles", () => {
    expect(fullDiskAccessRecheckStep(source())).toEqual({ step: "configure" });
  });
});

describe("refreshedSourceProfileDirectory", () => {
  const refreshed = source({
    profiles: [
      { directory: "Default", name: "Personal" },
      { directory: "Profile 2", name: "Work" },
    ],
  });

  it("preserves a selected non-first profile after the browser quits", () => {
    expect(refreshedSourceProfileDirectory("Profile 2", refreshed)).toBe("Profile 2");
  });

  it("falls back only when the old profile vanished and clears an empty result", () => {
    expect(refreshedSourceProfileDirectory("Removed", refreshed)).toBe("Default");
    expect(refreshedSourceProfileDirectory("Removed", source({ profiles: [] }))).toBe("");
  });
});

describe("isRetryableReason", () => {
  it("offers a retry for failures a second attempt can clear", () => {
    expect(isRetryableReason("needsKeychainApproval")).toBe(true);
    expect(isRetryableReason("keychainUnavailable")).toBe(true);
    expect(isRetryableReason("readFailed")).toBe(true);
  });

  it("does not offer a retry for a permanent failure", () => {
    expect(isRetryableReason("unsupportedPlatform")).toBe(false);
    expect(isRetryableReason("unknownSourceProfile")).toBe(false);
    // Retrying the same new-profile import cannot lower the profile count.
    expect(isRetryableReason("profileLimitReached")).toBe(false);
  });

  it("offers a retry once the user has signed in to create the missing key", () => {
    // The blocked copy tells the user to sign in and retry, so the screen
    // has to offer the retry it asks for.
    expect(isRetryableReason("keychainItemMissing")).toBe(true);
  });

  it("offers a retry when the cookies landed but the new profile was not saved", () => {
    expect(isRetryableReason("profileNotSaved")).toBe(true);
  });
});

describe("formatSkippedDomains", () => {
  it("joins a short list naturally", () => {
    expect(formatSkippedDomains([])).toBe("");
    expect(formatSkippedDomains(["a.com"])).toBe("a.com");
    expect(formatSkippedDomains(["a.com", "b.com"])).toBe("a.com and b.com");
    expect(formatSkippedDomains(["a.com", "b.com", "c.com"])).toBe("a.com, b.com and c.com");
  });

  it("summarizes a long list", () => {
    expect(formatSkippedDomains(["a.com", "b.com", "c.com", "d.com", "e.com"])).toBe(
      "a.com, b.com, c.com and 2 more",
    );
  });
});

const site = (domain: string, over: Partial<BrowserImportSite> = {}): BrowserImportSite => ({
  domain,
  cookieCount: 3,
  signedIn: true,
  current: false,
  ...over,
});

describe("orderSites", () => {
  it("puts the current site first, then the most recently used, then by name", () => {
    const ordered = orderSites([
      site("zeta.com"),
      site("old.com", { lastAccessedAt: 100 }),
      site("alpha.com"),
      site("here.com", { current: true, lastAccessedAt: 1 }),
      site("recent.com", { lastAccessedAt: 900 }),
    ]);
    expect(ordered.map((entry) => entry.domain)).toEqual([
      "here.com",
      "recent.com",
      "old.com",
      "alpha.com",
      "zeta.com",
    ]);
  });
});

describe("initialSiteSelection", () => {
  it("pre-ticks signed-in sites but never banking, email or sign-in ones", () => {
    expect(
      initialSiteSelection([
        site("bank.com", { sensitive: "banking" }),
        site("github.com"),
        site("cdn.com", { signedIn: false }),
        site("gmail.com", { sensitive: "email" }),
        site("okta.com", { sensitive: "signIn" }),
        site("linear.app"),
      ]),
    ).toEqual(["github.com", "linear.app"]);
  });

  it("pre-ticks at most the first five", () => {
    const sites = ["a", "b", "c", "d", "e", "f", "g"].map((name) => site(`${name}.com`));
    expect(initialSiteSelection(sites)).toEqual(["a.com", "b.com", "c.com", "d.com", "e.com"]);
  });
});

describe("filterSites", () => {
  const sites = [site("github.com"), site("GitLab.com"), site("bbc.co.uk")];

  it("matches part of a domain regardless of case and surrounding spaces", () => {
    expect(filterSites(sites, "  GIT ").map((entry) => entry.domain)).toEqual([
      "github.com",
      "GitLab.com",
    ]);
  });

  it("keeps every site for an empty query", () => {
    expect(filterSites(sites, "   ")).toEqual(sites);
  });
});

describe("capSiteRows", () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, index) => site(`site${index}.com`));

  it("shows every site up to the cap", () => {
    const sites = many(200);
    expect(capSiteRows(sites)).toEqual({ rows: sites, hidden: 0 });
  });

  it("shows the first 200 and counts the rest", () => {
    const capped = capSiteRows(many(1234));
    expect(capped.rows).toHaveLength(200);
    expect(capped.rows[0]?.domain).toBe("site0.com");
    expect(capped.rows.at(-1)?.domain).toBe("site199.com");
    expect(capped.hidden).toBe(1034);
  });
});

describe("siteBulkActionLabels", () => {
  it("selects all and clears all with no filter", () => {
    expect(siteBulkActionLabels("")).toEqual({ select: "Select all", clear: "Clear all" });
    expect(siteBulkActionLabels("   ")).toEqual({ select: "Select all", clear: "Clear all" });
  });

  it("says it only selects the shown sites while a filter is typed, and still clears all", () => {
    expect(siteBulkActionLabels("git")).toEqual({ select: "Select shown", clear: "Clear all" });
  });
});

describe("sitesOutcomeToStep", () => {
  it("lists the sites in import order", () => {
    expect(
      sitesOutcomeToStep({
        kind: "sites",
        sites: [site("b.com"), site("a.com", { current: true })],
      }),
    ).toEqual({ step: "sites", sites: [site("a.com", { current: true }), site("b.com")] });
  });

  it("routes a running browser back to the quit screen", () => {
    expect(sitesOutcomeToStep({ kind: "blocked", reason: "browserRunning" })).toEqual({
      step: "quit",
    });
  });

  it("asks for Full Disk Access again before returning to configure", () => {
    expect(sitesOutcomeToStep({ kind: "blocked", reason: "needsFullDiskAccess" })).toEqual({
      step: "fullDiskAccess",
      resume: "configure",
      checked: true,
    });
  });

  it("blocks on any other failure, retrying the listing rather than an import", () => {
    expect(sitesOutcomeToStep({ kind: "blocked", reason: "readFailed" })).toEqual({
      step: "blocked",
      reason: "readFailed",
      retry: "listSites",
    });
  });
});

describe("blockedRetryAction", () => {
  it("re-runs whatever failed", () => {
    expect(blockedRetryAction({ step: "blocked", reason: "readFailed", retry: "import" })).toBe(
      "import",
    );
    expect(blockedRetryAction({ step: "blocked", reason: "readFailed", retry: "listSites" })).toBe(
      "listSites",
    );
  });

  it("starts over from configure when the source was blocked before anything ran", () => {
    expect(blockedRetryAction({ step: "blocked", reason: "needsKeychainApproval" })).toBe(
      "configure",
    );
  });

  it("offers nothing for a failure a retry cannot clear", () => {
    expect(
      blockedRetryAction({ step: "blocked", reason: "unsupportedPlatform", retry: "import" }),
    ).toBeUndefined();
  });
});

describe("siteSelectionFor", () => {
  const listed = [
    site("github.com"),
    site("linear.app"),
    site("bank.com", { sensitive: "banking" }),
  ];

  it("keeps the user's ticks when the same profile is listed again", () => {
    expect(
      siteSelectionFor(
        { sourceProfileDirectory: "Default", domains: ["bank.com"] },
        "Default",
        listed,
      ),
    ).toEqual({ sourceProfileDirectory: "Default", domains: ["bank.com"] });
  });

  it("drops ticks for sites the profile no longer lists", () => {
    expect(
      siteSelectionFor(
        { sourceProfileDirectory: "Default", domains: ["gone.com", "linear.app"] },
        "Default",
        listed,
      ),
    ).toEqual({ sourceProfileDirectory: "Default", domains: ["linear.app"] });
  });

  it("starts from the default ticks for a different profile", () => {
    expect(
      siteSelectionFor(
        { sourceProfileDirectory: "Default", domains: ["bank.com"] },
        "Profile 2",
        listed,
      ),
    ).toEqual({ sourceProfileDirectory: "Profile 2", domains: ["github.com", "linear.app"] });
    expect(siteSelectionFor(undefined, "Default", listed)).toEqual({
      sourceProfileDirectory: "Default",
      domains: ["github.com", "linear.app"],
    });
  });
});

describe("selectedImportDomains", () => {
  it("imports the domains ticked for the chosen source profile", () => {
    expect(
      selectedImportDomains(
        { sourceProfileDirectory: "Default", domains: ["github.com", "linear.app"] },
        "Default",
      ),
    ).toEqual(["github.com", "linear.app"]);
  });

  it("refuses to import before any site is chosen", () => {
    expect(selectedImportDomains(undefined, "Default")).toBeUndefined();
    expect(
      selectedImportDomains({ sourceProfileDirectory: "Default", domains: [] }, "Default"),
    ).toBeUndefined();
  });

  it("refuses ticks made in another source profile", () => {
    expect(
      selectedImportDomains(
        { sourceProfileDirectory: "Profile 2", domains: ["github.com"] },
        "Default",
      ),
    ).toBeUndefined();
  });
});
