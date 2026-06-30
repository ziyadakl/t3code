/**
 * threadTitleRules — fork-local, provider-agnostic rules for deciding whether
 * (and by whom) a thread's first-turn auto-title may be set. Shared by
 * ProviderCommandReactor (the generic text-generation title path) and
 * SdkTitleReactor (the Claude Agent SDK summary path) so the two mirror-image
 * sites can't drift.
 *
 * @module threadTitleRules
 */
import { ProviderDriverKind } from "@t3tools/contracts";

/** Same placeholder the client seeds a new thread with (ChatView). */
export const DEFAULT_THREAD_TITLE = "New thread";

const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");

/**
 * A thread title may be overwritten only while it is still the auto seed: the
 * placeholder, or the title the client set on first send (the raw `titleSeed` it
 * sends on `thread.turn-start-requested`). A title that matches neither was
 * deliberately set by the user, so it is left alone.
 */
export const canReplaceThreadTitle = (
  currentTitle: string,
  titleSeed: string | undefined,
): boolean => {
  const trimmedCurrentTitle = currentTitle.trim();
  if (trimmedCurrentTitle === DEFAULT_THREAD_TITLE) {
    return true;
  }
  const trimmedTitleSeed = titleSeed?.trim();
  return trimmedTitleSeed !== undefined && trimmedTitleSeed.length > 0
    ? trimmedCurrentTitle === trimmedTitleSeed
    : false;
};

/**
 * Whether a thread bound to `driver` defers first-turn titling to the provider's
 * own session summary (the Claude Agent SDK, read by SdkTitleReactor) instead of
 * the generic text-generation title path. Both the skip in ProviderCommandReactor
 * and the claudeAgent-only gate in SdkTitleReactor route through this one
 * predicate so they stay in sync.
 */
export const defersTitleToSdk = (driver: ProviderDriverKind | undefined): boolean =>
  driver === CLAUDE_AGENT_DRIVER;
