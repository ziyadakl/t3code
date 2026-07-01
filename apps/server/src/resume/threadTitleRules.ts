/**
 * threadTitleRules — fork-local, provider-agnostic rules for deciding whether a
 * thread's first-turn auto-title may be set. Used by ProviderCommandReactor (the
 * generic text-generation title path) for every driver.
 *
 * @module threadTitleRules
 */

/** Same placeholder the client seeds a new thread with (ChatView). */
export const DEFAULT_THREAD_TITLE = "New thread";

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
