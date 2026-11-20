/**
 * Turns a skill mention anywhere in a prompt (`$skill` chip, typed `/skill`, or `/skill` in a
 * quote's note) into the slash invocation Claude Code runs. stream-json expands only a last text
 * block starting with `/`, one skill per message, so earlier mentions are rewritten to `/name`.
 *
 * @module provider/Drivers/ClaudeSkillDispatch
 */
import type { ServerProviderSkill } from "@t3tools/contracts";

import { collectAssistantCitations } from "@t3tools/shared/assistantCitations";
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
}

/**
 * Split `prompt` around the last `$skill` or typed `/skill` mention naming a known skill.
 * Returns `undefined` when there is nothing to dispatch; mentions matching no skill stay
 * literal (a `$HOME` or `/16:9` in prose must not become a command).
 */
export function planClaudeSkillDispatch(
  prompt: string,
  skills: ReadonlyMap<string, ClaudeSkillTarget>,
): ClaudeSkillDispatch | undefined {
  // `$name` uses the composer's own pattern, so a rendered chip and a
  // dispatched skill are always the same set; a typed `/name` joins them.
  const typedMentions = [SKILL_MENTION_PATTERN, TYPED_SLASH_PATTERN]
    .flatMap((pattern) => [...prompt.matchAll(pattern)])
    .flatMap((match) => {
      const name = match[2] ?? "";
      const skill = skills.get(name);
      if (!skill) return [];
      const start = (match.index ?? 0) + (match[1]?.length ?? 0);
      const end = (match.index ?? 0) + match[0].length;
      return [{ name, skill, start, end, text: `/${name}`, noteArgs: undefined }];
    });
  // A note's link stays verbatim: it is the quote, and its text is not a typed `/name`.
  const noteMentions = collectAssistantCitations(prompt).flatMap(({ citation, start, end }) => {
    const comment = citation.comment ?? "";
    const mention = [...comment.matchAll(TYPED_SLASH_PATTERN)]
      .map((match) => ({
        name: match[2] ?? "",
        skill: skills.get(match[2] ?? ""),
        args: comment.slice((match.index ?? 0) + match[0].length).trim(),
      }))
      .findLast((candidate) => candidate.skill !== undefined);
    if (!mention?.skill) return [];
    const { name, skill, args } = mention;
    return [{ name, skill, start, end, text: prompt.slice(start, end), noteArgs: args }];
  });
  const mentions = [...typedMentions, ...noteMentions].sort(
    (left, right) => left.start - right.start,
  );
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
    promptWithInlineSlashes += `${prompt.slice(cursor, mention.start)}${mention.text}`;
    if (mention.skill.userInvocationOnly === true && !annotated.has(mention.name)) {
      promptWithInlineSlashes += ` [The user invoked this skill. Follow the instructions at: ${mention.skill.path}]`;
      annotated.add(mention.name);
    }
    cursor = mention.end;
  }
  promptWithInlineSlashes = `${promptWithInlineSlashes}${prompt.slice(cursor)}`.trimEnd();

  if (last.noteArgs !== undefined) {
    // The quote goes ahead; the note's own words, then the text after the quote, are the args.
    return {
      leadingText: promptWithInlineSlashes,
      commandText: [`/${last.name}`, last.noteArgs, prompt.slice(last.end).trim()]
        .filter((part) => part.length > 0)
        .join(" "),
    };
  }
  return {
    leadingText:
      prompt.slice(0, last.start).trim().length > 0 ? promptWithInlineSlashes : undefined,
    commandText: `/${last.name}${prompt.slice(last.end)}`.trimEnd(),
  };
}
