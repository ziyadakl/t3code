/**
 * ClaudeSkillDispatch — turns a skill mention anywhere in a composer prompt,
 * a `$skill` chip or a typed `/skill`, into the slash invocation Claude Code
 * actually runs.
 *
 * The composer inserts `$name` for every provider. Codex parses that natively;
 * Claude Code does not, and treats it as prose. The Claude Code CLI and
 * desktop input boxes do run a typed `/name` from anywhere in the message,
 * but T3 talks to the CLI over stream-json, which has no input box. There the
 * only user-side invocation is a text block whose first character is `/`: the harness
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
 * So one mention anywhere in the prompt becomes a guaranteed invocation, and
 * the user's text on either side is kept in order.
 *
 * @module provider/Drivers/ClaudeSkillDispatch
 */
import type { ServerProviderSkill } from "@t3tools/contracts";

import { SKILL_MENTION_PATTERN, SKILL_NAME_SOURCE } from "@t3tools/shared/composerInlineTokens";

/**
 * A typed `/name`, with the same name characters as a `$name` chip.
 * `/etc/hosts` and `src/x` never match: the name must stand alone between
 * whitespace. Sentence punctuation after it ("try /review.") is consumed and
 * dropped, so it never becomes part of the command.
 */
const TYPED_SLASH_PATTERN = new RegExp(`(^|\\s)\\/(${SKILL_NAME_SOURCE})[.,;?!]*(?=\\s|$)`, "gu");

export type ClaudeSkillTarget = Pick<ServerProviderSkill, "path" | "userInvocationOnly">;

export interface ClaudeSkillDispatch {
  /** The whole prompt with mentions as `/name`, or `undefined` when the mention opens it. */
  readonly leadingText: string | undefined;
  /** `/name` plus the trailing text, ready to be the message's last text block. */
  readonly commandText: string;
  readonly skillName: string;
}

/**
 * Split `prompt` around the last `$skill` or typed `/skill` mention that
 * names a known skill. Returns `undefined` when there is nothing to dispatch,
 * in which case the prompt should go out unchanged. Mentions that do not
 * match a discovered skill stay literal: a `$HOME` or a `/16:9` in prose must
 * not become a command.
 */
export function planClaudeSkillDispatch(
  prompt: string,
  skills: ReadonlyMap<string, ClaudeSkillTarget>,
): ClaudeSkillDispatch | undefined {
  // `$name` uses the composer's own pattern, so a rendered chip and a
  // dispatched skill are always the same set; a typed `/name` joins them.
  const mentions = [SKILL_MENTION_PATTERN, TYPED_SLASH_PATTERN]
    .flatMap((pattern) => [...prompt.matchAll(pattern)])
    .flatMap((match) => {
      const name = match[2] ?? "";
      const skill = skills.get(name);
      if (!skill) return [];
      const start = (match.index ?? 0) + (match[1]?.length ?? 0);
      return [{ name, skill, start, end: (match.index ?? 0) + match[0].length }];
    })
    .sort((left, right) => left.start - right.start);
  const last = mentions.at(-1);
  if (!last) {
    return undefined;
  }

  // Only the final skill gets native expansion. Earlier user-only skills need
  // a fallback to their raw file because Claude's Skill tool refuses them.
  const annotated = new Set([last.name]);
  let promptWithInlineSlashes = "";
  let cursor = 0;
  for (const mention of mentions) {
    promptWithInlineSlashes += `${prompt.slice(cursor, mention.start)}/${mention.name}`;
    if (mention.skill.userInvocationOnly === true && !annotated.has(mention.name)) {
      promptWithInlineSlashes += ` [The user invoked this skill. Follow the instructions at: ${mention.skill.path}]`;
      annotated.add(mention.name);
    }
    cursor = mention.end;
  }
  promptWithInlineSlashes = `${promptWithInlineSlashes}${prompt.slice(cursor)}`.trimEnd();

  return {
    leadingText:
      prompt.slice(0, last.start).trim().length > 0 ? promptWithInlineSlashes : undefined,
    commandText: `/${last.name}${prompt.slice(last.end)}`.trimEnd(),
    skillName: last.name,
  };
}
