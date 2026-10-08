/**
 * ClaudeSkillDispatch — turns `$skill` mentions in a composer prompt into the
 * slash invocation Claude Code actually runs.
 *
 * The composer inserts `$name` for every provider. Codex parses that natively;
 * Claude Code does not, and treats it as prose. Claude Code's only user-side
 * invocation is a text block whose first character is `/`: the harness
 * expands `/name args` into the SKILL.md body, and every character after the
 * name (newlines included) arrives as `ARGUMENTS`. Verified against the CLI in
 * stream-json mode, which is what the Agent SDK uses:
 *
 *  - The check runs on the LAST text block of the message. Earlier text
 *    blocks are preserved verbatim, and image blocks may sit before it.
 *  - Leading whitespace, or a `/name` that starts a later line of the same
 *    block, is literal text.
 *  - Only one skill expands per message; a second `/x` becomes argument text
 *    (anthropics/claude-code#87113). The model still starts the rest through
 *    its Skill tool when it reads `/name` in the prompt, so earlier mentions
 *    are rewritten to `/name` inline.
 *
 * A `/name` typed mid-prompt is treated the same way, since the CLI and
 * desktop input boxes run it from anywhere in the message.
 *
 * So one mention anywhere in the prompt becomes a guaranteed invocation, and
 * the user's text on either side is kept in order.
 *
 * @module provider/Drivers/ClaudeSkillDispatch
 */

/**
 * Same token shape the composer and timeline chips recognise
 * (`packages/shared/src/composerInlineTokens.ts`), so a rendered chip and a
 * dispatched skill are always the same set.
 */
const SKILL_MENTION_PATTERN =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;

/**
 * A `/name` typed anywhere in the prompt, as the Claude Code CLI and desktop
 * app accept it. Their input box handles that; stream-json does not, so it
 * goes through the same move as a `$` mention. `/etc/hosts` and `src/x` never
 * match: the name must stand alone between whitespace.
 */
const TYPED_SLASH_PATTERN = /(^|\s)\/([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;

/**
 * Plugin skills run as `/plugin:skill`. Skill discovery only scans the user
 * and project skill roots, so a typed plugin command is trusted by its shape.
 */
const PLUGIN_COMMAND_NAME =
  /^[a-zA-Z0-9_-]*[a-zA-Z][a-zA-Z0-9_-]*:[a-zA-Z0-9_-]*[a-zA-Z][a-zA-Z0-9_-]*$/u;

export interface ClaudeSkillDispatch {
  /** Text before the dispatched mention, or `undefined` when it opens the prompt. */
  readonly leadingText: string | undefined;
  /** `/name` plus the trailing text, ready to be the message's last text block. */
  readonly commandText: string;
  readonly skillName: string;
}

/**
 * Split `prompt` around the last `$skill` or typed `/skill` mention that
 * names a known skill (or, for `/`, a plugin skill).
 * Returns `undefined` when there is nothing to dispatch, in which case the
 * prompt should go out unchanged. Mentions that do not match a discovered
 * skill stay literal: a `$HOME` in prose must not become a command.
 */
export function planClaudeSkillDispatch(
  prompt: string,
  skillNames: ReadonlySet<string>,
): ClaudeSkillDispatch | undefined {
  const toMention = (match: RegExpMatchArray) => ({
    name: match[2] ?? "",
    start: (match.index ?? 0) + (match[1]?.length ?? 0),
    end: (match.index ?? 0) + match[0].length,
  });
  const mentions = [
    ...[...prompt.matchAll(SKILL_MENTION_PATTERN)]
      .map(toMention)
      .filter((mention) => skillNames.has(mention.name)),
    ...[...prompt.matchAll(TYPED_SLASH_PATTERN)]
      .map(toMention)
      .filter((mention) => skillNames.has(mention.name) || PLUGIN_COMMAND_NAME.test(mention.name)),
  ].sort((left, right) => left.start - right.start);
  const last = mentions.at(-1);
  if (!last) {
    return undefined;
  }

  const leading = prompt.slice(0, last.start);
  const trailing = prompt.slice(last.end);
  const leadingWithInlineSlashes = mentions
    .slice(0, -1)
    .reduceRight(
      (text, mention) =>
        `${text.slice(0, mention.start)}/${mention.name}${text.slice(mention.end)}`,
      leading,
    )
    .trimEnd();

  return {
    leadingText: leadingWithInlineSlashes.length > 0 ? leadingWithInlineSlashes : undefined,
    commandText: `/${last.name}${trailing}`.trimEnd(),
    skillName: last.name,
  };
}
