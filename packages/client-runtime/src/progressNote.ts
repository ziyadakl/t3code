/**
 * Longest single-line assistant message that a finished turn's "Worked for"
 * fold may hide as a progress note ("Let me check X.").
 */
export const PROGRESS_NOTE_MAX_CHARS = 160;

/**
 * A finished turn folds tool steps, thinking, and short progress notes. An
 * assistant message is a foldable progress note only when, after trimming, it
 * is one line of at most {@link PROGRESS_NOTE_MAX_CHARS} characters. Anything
 * longer or multi-line (plans, lists, headings, answers) stays visible. The
 * caller keeps the turn's terminal assistant message visible regardless.
 */
export function isFoldableProgressNote(text: string): boolean {
  const trimmed = text.trim();
  return !trimmed.includes("\n") && trimmed.length <= PROGRESS_NOTE_MAX_CHARS;
}
