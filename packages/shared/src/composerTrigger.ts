export type ComposerTriggerKind = "path" | "slash-command" | "skill";
export type ComposerSlashCommand = "model" | "plan" | "default" | "resume";

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

const SIMPLE_MENTION_PATH_REGEX = /^[^\s@"\\]+$/;

export function serializeComposerMentionPath(path: string): string {
  if (SIMPLE_MENTION_PATH_REGEX.test(path)) {
    return path;
  }
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r";
}

/**
 * Detect an active trigger (@path, $skill, /command) at the cursor position.
 *
 * All three triggers key off the whitespace-delimited token ending at the
 * cursor, so a `/command` can be typed mid-prompt (e.g. "do you need to
 * /grill-m"), matching the Claude Code CLI — not only at the start of a line.
 *
 * Accepts an optional `isWhitespaceChar` override so callers with inline
 * placeholder characters (e.g. terminal-context chips on web) can treat
 * those as token boundaries.
 */
export function detectComposerTrigger(
  text: string,
  cursorInput: number,
  isWhitespaceChar?: (char: string) => boolean,
): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const wsCheck = isWhitespaceChar ?? isWhitespace;

  let tokenIdx = cursor - 1;
  while (tokenIdx >= 0 && !wsCheck(text[tokenIdx] ?? "")) {
    tokenIdx -= 1;
  }
  const tokenStart = tokenIdx + 1;
  const token = text.slice(tokenStart, cursor);

  // A slash command is a single token with no path separator — `/grill-me`,
  // not `/etc/hosts` or `https://host/path`. Requiring no further `/` keeps
  // absolute paths and URLs from popping the command menu mid-prompt.
  if (token.startsWith("/") && !token.includes("/", 1)) {
    return {
      kind: "slash-command",
      query: token.slice(1),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  if (token.startsWith("$")) {
    return {
      kind: "skill",
      query: token.slice(1),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  if (token.startsWith("@")) {
    return {
      kind: "path",
      query: token.slice(1),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }

  return null;
}

export function parseStandaloneComposerSlashCommand(
  text: string,
): Exclude<ComposerSlashCommand, "model" | "resume"> | null {
  const match = /^\/(plan|default)\s*$/i.exec(text.trim());
  if (!match) {
    return null;
  }
  const command = match[1]?.toLowerCase();
  if (command === "plan") return "plan";
  return "default";
}

export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  const nextText = `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`;
  return { text: nextText, cursor: safeStart + replacement.length };
}
