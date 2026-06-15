import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveProviderInstanceEntries,
  resolveProviderDriverKindForInstanceSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { resolveSelectableProvider } from "../../providerModels";
import { deriveEffectiveComposerModelState } from "../../composerDraftStore";
import { resolveComposerProviderTarget } from "./resolveComposerProviderTarget";
import { shouldShowProviderStatusBanner } from "./ProviderStatusBanner";

const CODEX = ProviderInstanceId.make("codex");
const CLAUDE = ProviderInstanceId.make("claudeAgent");

function provider(input: {
  instanceId: ProviderInstanceId;
  driver: ProviderDriverKind;
  enabled: boolean;
  status: ServerProvider["status"];
  models?: ReadonlyArray<{ slug: string; name: string }>;
}): ServerProvider {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    enabled: input.enabled,
    installed: input.status === "ready",
    version: null,
    status: input.status,
    auth: { status: input.enabled ? "authenticated" : "unknown" },
    checkedAt: "2026-06-04T00:21:51.119Z",
    models: (input.models ?? []).map((m) => ({
      slug: m.slug,
      name: m.name,
      isCustom: false,
      capabilities: {},
    })),
    slashCommands: [],
    skills: [],
  };
}

// Mirrors the user's real machine state (from ~/.t3/caches): Codex disabled,
// only Claude enabled and ready. The project default is Codex.
function disabledCodexOnlyClaudeEnabled(): ReadonlyArray<ServerProvider> {
  return [
    provider({
      instanceId: CODEX,
      driver: ProviderDriverKind.make("codex"),
      enabled: false,
      status: "disabled",
      models: [],
    }),
    provider({
      instanceId: CLAUDE,
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      status: "ready",
      models: [{ slug: "claude-opus-4-8", name: "Claude Opus 4.8" }],
    }),
  ];
}

const settings: UnifiedSettings = DEFAULT_UNIFIED_SETTINGS;

describe("draft provider-identity divergence (the bug)", () => {
  // These assertions document the two composer resolution paths that
  // disagreed: the displayed model NAME fell back to the enabled Claude, but
  // the picker IDENTITY (icon + auto-opened tab) stayed on the disabled Codex
  // project default. That mismatch is BUG 2 — a Claude model under a Codex
  // icon opening an empty Codex tab.
  const providers = disabledCodexOnlyClaudeEnabled();

  it("the model resolution swaps a disabled Codex default to the enabled Claude", () => {
    // This is the path that produces the displayed model NAME.
    const { selectedModel } = deriveEffectiveComposerModelState({
      draft: null,
      providers,
      selectedProvider: ProviderDriverKind.make("codex"),
      selectedInstanceId: CODEX,
      threadModelSelection: null,
      projectModelSelection: { instanceId: CODEX, model: "gpt-5.4" },
      settings,
    });
    expect(selectedModel).toBe("claude-opus-4-8");
    // …and `resolveSelectableProvider` agrees: disabled Codex → enabled Claude.
    expect(resolveSelectableProvider(providers, ProviderDriverKind.make("codex"))).toBe(
      "claudeAgent",
    );
  });

  it("but the identity resolution keeps the disabled Codex (the divergence)", () => {
    // This is the path that produced the picker ICON / TAB and the banner
    // provider — it does NOT check `enabled`, so it stays on Codex while the
    // model above went to Claude.
    const entries = sortProviderInstanceEntries(deriveProviderInstanceEntries(providers));
    expect(resolveProviderDriverKindForInstanceSelection(entries, providers, CODEX)).toBe("codex");
  });
});

describe("resolveComposerProviderTarget (the fix)", () => {
  it("falls back to the enabled provider when the project default is disabled", () => {
    const providers = disabledCodexOnlyClaudeEnabled();
    const entries = sortProviderInstanceEntries(deriveProviderInstanceEntries(providers));
    const target = resolveComposerProviderTarget({
      entries,
      // Fresh draft: no pick, no thread, project default = codex.
      candidates: [null, null, null, CODEX],
      lockedProvider: null,
      lockedContinuationGroupKey: null,
    });
    // Identity now matches the model that actually resolves: Claude.
    expect(target.instanceId).toBe("claudeAgent");
    expect(target.driverKind).toBe("claudeAgent");

    // And the model resolved under that identity is still claude-opus-4-8,
    // so icon + tab + model agree.
    const { selectedModel } = deriveEffectiveComposerModelState({
      draft: null,
      providers,
      selectedProvider: target.driverKind,
      selectedInstanceId: target.instanceId,
      threadModelSelection: null,
      projectModelSelection: { instanceId: CODEX, model: "gpt-5.4" },
      settings,
    });
    expect(selectedModel).toBe("claude-opus-4-8");
  });

  it("keeps an ENABLED project default unchanged (no regression)", () => {
    const providers = [
      provider({
        instanceId: CODEX,
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        status: "ready",
        models: [{ slug: "gpt-5.4", name: "GPT-5.4" }],
      }),
      provider({
        instanceId: CLAUDE,
        driver: ProviderDriverKind.make("claudeAgent"),
        enabled: true,
        status: "ready",
        models: [{ slug: "claude-opus-4-8", name: "Claude Opus 4.8" }],
      }),
    ];
    const entries = sortProviderInstanceEntries(deriveProviderInstanceEntries(providers));
    const target = resolveComposerProviderTarget({
      entries,
      candidates: [null, null, null, CODEX],
      lockedProvider: null,
      lockedContinuationGroupKey: null,
    });
    expect(target.instanceId).toBe("codex");
    expect(target.driverKind).toBe("codex");
  });

  it("honours an explicit enabled draft pick over the project default", () => {
    const providers = disabledCodexOnlyClaudeEnabled();
    const entries = sortProviderInstanceEntries(deriveProviderInstanceEntries(providers));
    const target = resolveComposerProviderTarget({
      entries,
      // Draft pick = claudeAgent (enabled); project default = codex.
      candidates: [CLAUDE, null, null, CODEX],
      lockedProvider: null,
      lockedContinuationGroupKey: null,
    });
    expect(target.instanceId).toBe("claudeAgent");
  });

  it("respects a thread lock to a specific driver kind", () => {
    const providers = [
      provider({
        instanceId: CODEX,
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        status: "ready",
        models: [{ slug: "gpt-5.4", name: "GPT-5.4" }],
      }),
      provider({
        instanceId: CLAUDE,
        driver: ProviderDriverKind.make("claudeAgent"),
        enabled: true,
        status: "ready",
        models: [{ slug: "claude-opus-4-8", name: "Claude Opus 4.8" }],
      }),
    ];
    const entries = sortProviderInstanceEntries(deriveProviderInstanceEntries(providers));
    const target = resolveComposerProviderTarget({
      entries,
      // Project default codex, but the thread is locked to claudeAgent.
      candidates: [null, CLAUDE, null, CODEX],
      lockedProvider: ProviderDriverKind.make("claudeAgent"),
      lockedContinuationGroupKey: null,
    });
    expect(target.instanceId).toBe("claudeAgent");
    expect(target.driverKind).toBe("claudeAgent");
  });

  it("preserves a concrete identity when nothing is enabled", () => {
    const providers = [
      provider({
        instanceId: CODEX,
        driver: ProviderDriverKind.make("codex"),
        enabled: false,
        status: "disabled",
        models: [],
      }),
    ];
    const entries = sortProviderInstanceEntries(deriveProviderInstanceEntries(providers));
    const target = resolveComposerProviderTarget({
      entries,
      candidates: [null, null, null, CODEX],
      lockedProvider: null,
      lockedContinuationGroupKey: null,
    });
    expect(target.instanceId).toBe("codex");
    expect(target.driverKind).toBe("codex");
  });
});

// ChatView resolves the draft-status banner through this SAME helper, so the
// picker icon/tab and the banner always land on one provider. This mirrors
// ChatView's draft branch: resolve the target instance, then read its snapshot.
function resolveDraftBannerStatus(
  providers: ReadonlyArray<ServerProvider>,
  projectDefaultInstanceId: ProviderInstanceId,
): ServerProvider | null {
  const entries = sortProviderInstanceEntries(deriveProviderInstanceEntries(providers));
  const target = resolveComposerProviderTarget({
    entries,
    candidates: [null, null, null, projectDefaultInstanceId],
    lockedProvider: null,
    lockedContinuationGroupKey: null,
  });
  return providers.find((p) => p.instanceId === target.instanceId) ?? null;
}

describe("picker identity and draft banner stay in lockstep", () => {
  it("disabled Codex default: both resolve to Claude and no banner shows", () => {
    const providers = disabledCodexOnlyClaudeEnabled();
    const entries = sortProviderInstanceEntries(deriveProviderInstanceEntries(providers));
    const target = resolveComposerProviderTarget({
      entries,
      candidates: [null, null, null, CODEX],
      lockedProvider: null,
      lockedContinuationGroupKey: null,
    });
    const bannerStatus = resolveDraftBannerStatus(providers, CODEX);
    expect(target.driverKind).toBe("claudeAgent");
    expect(bannerStatus?.instanceId).toBe("claudeAgent");
    expect(shouldShowProviderStatusBanner(bannerStatus)).toBe(false);
  });

  it("enabled-but-NOT-INSTALLED Codex default moves to Claude and hides the banner", () => {
    // The exact VPS case: Codex is enabled on the remote server but its CLI
    // isn't installed (status "error"), while Claude is enabled and ready. A
    // draft must follow the ready provider, not raise Codex's "not installed"
    // banner for a provider it isn't running.
    const providers = [
      provider({
        instanceId: CODEX,
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        status: "error",
        models: [],
      }),
      provider({
        instanceId: CLAUDE,
        driver: ProviderDriverKind.make("claudeAgent"),
        enabled: true,
        status: "ready",
        models: [{ slug: "claude-opus-4-8", name: "Claude Opus 4.8" }],
      }),
    ];
    const entries = sortProviderInstanceEntries(deriveProviderInstanceEntries(providers));
    const target = resolveComposerProviderTarget({
      entries,
      candidates: [null, null, null, CODEX],
      lockedProvider: null,
      lockedContinuationGroupKey: null,
    });
    const bannerStatus = resolveDraftBannerStatus(providers, CODEX);
    expect(target.driverKind).toBe("claudeAgent");
    expect(bannerStatus?.instanceId).toBe("claudeAgent");
    expect(shouldShowProviderStatusBanner(bannerStatus)).toBe(false);
  });

  it("Codex enabled-but-broken as the ONLY provider still warns", () => {
    // No ready alternative exists, so the broken provider is surfaced and its
    // banner shows — a genuinely useful warning, not noise.
    const providers = [
      provider({
        instanceId: CODEX,
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        status: "error",
        models: [],
      }),
    ];
    const entries = sortProviderInstanceEntries(deriveProviderInstanceEntries(providers));
    const target = resolveComposerProviderTarget({
      entries,
      candidates: [null, null, null, CODEX],
      lockedProvider: null,
      lockedContinuationGroupKey: null,
    });
    const bannerStatus = resolveDraftBannerStatus(providers, CODEX);
    expect(target.driverKind).toBe("codex");
    expect(bannerStatus?.instanceId).toBe("codex");
    expect(shouldShowProviderStatusBanner(bannerStatus)).toBe(true);
  });
});
