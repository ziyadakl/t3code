import { describe, expect, it } from "vite-plus/test";

import { resolveSidebarRowQuickActions } from "./rowQuickActions";

describe("resolveSidebarRowQuickActions", () => {
  const everything = {
    settlementSupported: true,
    snoozeSupported: true,
    canSnoozeNow: true,
    hasUnsentDraft: true,
  };

  // Grouped active rows render slim; they must still offer the card's actions.
  it("offers discard draft, snooze and settle on an active thread row", () => {
    expect(resolveSidebarRowQuickActions({ variantAction: "settle", ...everything })).toEqual([
      "discard-draft",
      "snooze",
      "settle",
    ]);
  });

  it("drops snooze when the thread cannot be snoozed right now", () => {
    expect(
      resolveSidebarRowQuickActions({
        variantAction: "settle",
        ...everything,
        canSnoozeNow: false,
        hasUnsentDraft: false,
      }),
    ).toEqual(["settle"]);
  });

  it("keeps settled rows to un-settle and snoozed rows to wake", () => {
    expect(resolveSidebarRowQuickActions({ variantAction: "unsettle", ...everything })).toEqual([
      "unsettle",
    ]);
    expect(resolveSidebarRowQuickActions({ variantAction: "unsnooze", ...everything })).toEqual([
      "wake",
    ]);
    expect(
      resolveSidebarRowQuickActions({
        variantAction: "unsnooze",
        ...everything,
        snoozeSupported: false,
      }),
    ).toEqual([]);
  });
});
