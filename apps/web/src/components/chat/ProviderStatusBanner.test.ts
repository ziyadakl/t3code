import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { shouldShowProviderStatusBanner } from "./ProviderStatusBanner";

function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("shouldShowProviderStatusBanner", () => {
  it("hides when there is no status", () => {
    expect(shouldShowProviderStatusBanner(null)).toBe(false);
  });

  it("hides a disabled provider even when its probe reports an error", () => {
    // The exact case from the bug: Codex disabled in settings, but its probe
    // still reports "CLI not installed". It must not surface a red banner.
    expect(
      shouldShowProviderStatusBanner(
        provider({ enabled: false, installed: false, status: "error" }),
      ),
    ).toBe(false);
  });

  it("hides a healthy (ready) provider", () => {
    expect(shouldShowProviderStatusBanner(provider({ status: "ready" }))).toBe(false);
  });

  it("hides a provider the server already marks disabled", () => {
    expect(shouldShowProviderStatusBanner(provider({ status: "disabled" }))).toBe(false);
  });

  it("shows an enabled provider that is genuinely in error", () => {
    expect(
      shouldShowProviderStatusBanner(
        provider({ enabled: true, installed: false, status: "error" }),
      ),
    ).toBe(true);
  });
});
