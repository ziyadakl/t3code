/**
 * A `/compact` message as Claude Code reads it: `/compact` (any case), then optionally
 * whitespace and focus instructions. Returns the trimmed instructions ("" for bare), or null
 * when not a compact command (`/compacting` is not). Whitespace is JavaScript's `\s`, the
 * set the projection store's SQL match uses too.
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
