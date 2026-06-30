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
 * True when `token` is slash-command-shaped: it starts with `/` and contains
 * no second `/`. The single-segment rule keeps absolute paths (`/etc/hosts`)
 * and URLs (`https://host/path`) from being treated as commands. This is the
 * one notion of "looks like a /command" shared across detection, the leading
 * check, and the hoist below.
 */
function isSlashCommandToken(token: string): boolean {
  return token.startsWith("/") && !token.includes("/", 1);
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
  if (isSlashCommandToken(token)) {
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

/**
 * True when the text's first whitespace-delimited token is slash-command-shaped
 * (per `isSlashCommandToken`). Used to detect a `/command` already at the very
 * front of a message so callers don't displace it — e.g. the Claude ultrathink
 * effort prefix must NOT be prepended ahead of a leading command, since the
 * Agent SDK only fires a slash command when it is the leading content.
 */
export function startsWithSlashCommandToken(text: string): boolean {
  const trimmed = text.trimStart();
  let end = 0;
  while (end < trimmed.length && !isWhitespace(trimmed[end] ?? "")) {
    end += 1;
  }
  return isSlashCommandToken(trimmed.slice(0, end));
}

/**
 * Hoist a single inline `/command` to the front so the Agent SDK fires it.
 *
 * The SDK only treats a message as a slash command when the command is the
 * LEADING content; a command typed mid-prompt is otherwise sent as plain prose
 * and silently does nothing. This rewrites the (trimmed) text so the command
 * leads, preserving the rest as trailing context.
 *
 * Transform (only when it applies): given exactly one recognized command token
 * that is NOT already leading, take everything from that token to the end of
 * the message as the new leading content (the command plus its args), then
 * append the text that preceded it after a blank line. Example with `grill-me`
 * recognized:
 *   "remove Someday — #495 then /grill-me on Phase 3 — #400"
 *     -> "/grill-me on Phase 3 — #400\n\nremove Someday — #495 then"
 *
 * Returns the text unchanged when no rewrite applies: zero recognized commands,
 * more than one (ambiguous — we won't guess which wins), the command already
 * leading, or an unrecognized / path-shaped token (`/etc/hosts`). A command
 * "wins" the whole turn, which is the accepted limitation: a mixed message
 * can't both run a command and be processed as prose.
 *
 * `knownCommandNames` is the set of recognized command names (without the
 * leading `/`) for the active provider; only tokens whose name is in this set
 * are considered, so arbitrary `/words` never get hoisted.
 */
export function hoistLeadingSlashCommand(
  text: string,
  knownCommandNames: ReadonlySet<string>,
): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return text;
  }

  // Scan whitespace-delimited tokens, recording the start offset of every
  // recognized command token.
  const commandStarts: Array<number> = [];
  let cursor = 0;
  const length = trimmed.length;
  while (cursor < length) {
    while (cursor < length && isWhitespace(trimmed[cursor] ?? "")) {
      cursor += 1;
    }
    if (cursor >= length) {
      break;
    }
    const tokenStart = cursor;
    while (cursor < length && !isWhitespace(trimmed[cursor] ?? "")) {
      cursor += 1;
    }
    const token = trimmed.slice(tokenStart, cursor);
    if (isSlashCommandToken(token) && knownCommandNames.has(token.slice(1))) {
      commandStarts.push(tokenStart);
    }
  }

  // Only act on an unambiguous, non-leading command.
  if (commandStarts.length !== 1) {
    return text;
  }
  const start = commandStarts[0] ?? 0;
  if (start === 0) {
    return text;
  }

  const leading = trimmed.slice(start);
  const trailing = trimmed.slice(0, start).trimEnd();
  return trailing.length > 0 ? `${leading}\n\n${trailing}` : leading;
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
