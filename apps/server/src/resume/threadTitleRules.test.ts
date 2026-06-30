import { ProviderDriverKind } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { canReplaceThreadTitle, defersTitleToSdk } from "./threadTitleRules.ts";

const DEFAULT_TITLE = "New thread";

// ===========================================================================
// canReplaceThreadTitle
// ===========================================================================

it("canReplaceThreadTitle: the placeholder default is always replaceable", () => {
  assert.isTrue(canReplaceThreadTitle(DEFAULT_TITLE, undefined));
  assert.isTrue(canReplaceThreadTitle(DEFAULT_TITLE, "some seed"));
  // Default wins even when whitespace-padded.
  assert.isTrue(canReplaceThreadTitle("  New thread  ", undefined));
});

it("canReplaceThreadTitle: a title equal to the seed is replaceable", () => {
  assert.isTrue(canReplaceThreadTitle("Do the thing", "Do the thing"));
  // Seed comparison is whitespace-insensitive on both sides.
  assert.isTrue(canReplaceThreadTitle("  Do the thing  ", "Do the thing"));
});

it("canReplaceThreadTitle: a title that is neither default nor the seed is left alone", () => {
  assert.isFalse(canReplaceThreadTitle("Custom name", "Do the thing"));
});

it("canReplaceThreadTitle: a non-default title with an empty/undefined seed is left alone", () => {
  assert.isFalse(canReplaceThreadTitle("Custom name", undefined));
  assert.isFalse(canReplaceThreadTitle("Custom name", ""));
  assert.isFalse(canReplaceThreadTitle("Custom name", "   "));
});

// ===========================================================================
// defersTitleToSdk
// ===========================================================================

it("defersTitleToSdk: true only for the claudeAgent driver", () => {
  assert.isTrue(defersTitleToSdk(ProviderDriverKind.make("claudeAgent")));
});

it("defersTitleToSdk: false for non-claude drivers", () => {
  assert.isFalse(defersTitleToSdk(ProviderDriverKind.make("codex")));
  assert.isFalse(defersTitleToSdk(ProviderDriverKind.make("cursor")));
  assert.isFalse(defersTitleToSdk(ProviderDriverKind.make("grok")));
  assert.isFalse(defersTitleToSdk(ProviderDriverKind.make("opencode")));
});

it("defersTitleToSdk: false when the driver is undefined (instance not found)", () => {
  assert.isFalse(defersTitleToSdk(undefined));
});
