/**
 * A `/compact` message, as Claude Code reads it: the word `/compact`
 * (any case), then optionally whitespace and focus instructions. Returns the
 * trimmed instructions ("" for a bare `/compact`), or null when the text is
 * not a compact command. `/compacting` and `/compactx` are not.
 *
 * Whitespace is JavaScript's `\s`, the set `String.prototype.trim` strips;
 * the projection store's SQL match uses the same set.
 */
export function parseCompactCommand(text: string): string | null {
  const match = /^\/compact(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  if (match === null) return null;
  return match[1]?.trim() ?? "";
}

export function isCompactCommand(text: string): boolean {
  return parseCompactCommand(text) !== null;
}

/**
 * The text a provider receives for a compact turn: `/compact` plus any
 * instructions, with the command word normalised. Text that is not a compact
 * command yields a bare `/compact`.
 */
export function normalizeCompactCommand(text: string): string {
  const instructions = parseCompactCommand(text) ?? "";
  return instructions === "" ? "/compact" : `/compact ${instructions}`;
}
