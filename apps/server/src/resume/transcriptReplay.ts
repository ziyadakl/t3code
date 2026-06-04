/**
 * transcriptReplay — maps a Claude SDK session transcript (as returned by the
 * SDK's `getSessionMessages`) into the t3 orchestration commands that re-render
 * the conversation in a thread, for the /resume "show the old messages" path.
 *
 * v1 maps TEXT only (user + assistant). Tool-call / tool-result blocks are not
 * yet rendered as activities — tracked as a follow-up; the conversation text
 * still displays. The model gets full prior context via the resume cursor
 * regardless of how much is displayed (see ResumeSeedReactor).
 *
 * Determinism: each command gets a `server:resume-replay:<sessionId>:<seq>`
 * commandId (so a re-run dedupes via command receipts) and a monotonic
 * `createdAt` (so the SQL projection, which orders by created_at, renders them
 * in transcript order and strictly before any later live message).
 *
 * @module transcriptReplay
 */
import { CommandId, MessageId, type OrchestrationCommand, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** The commands buildReplayCommands emits (all carry `createdAt`). */
export type ReplayCommand = Extract<
  OrchestrationCommand,
  {
    readonly type:
      | "thread.message.user.record"
      | "thread.message.assistant.delta"
      | "thread.message.assistant.complete";
  }
>;

/** Narrow view of the SDK `SessionMessage` (its `message` field is `unknown`). */
export interface ReplaySessionMessage {
  readonly type: string; // "user" | "assistant" | "system"
  readonly uuid: string;
  readonly message: unknown; // raw Anthropic message: { role, content }
}

export interface ReplayContext {
  readonly threadId: ThreadId;
  readonly sessionId: string;
  /** Anchor for minted timestamps; the reactor passes a wall-clock now. */
  readonly baseTimeMs: number;
}

/** Concatenate the text of an Anthropic message whose content is a string or block array. */
function extractText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: "text"; text: string } =>
          !!block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text)
      .join("");
  }
  return "";
}

const COMMAND_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;

/**
 * Terminal Claude records a slash-command / skill invocation as a user message
 * whose text is an XML-ish wrapper, e.g.
 *   <command-name>/sandcastle-status</command-name>
 *   <command-message>sandcastle-status</command-message>
 *   <command-args></command-args>
 * t3 renders user text as plain text, so replayed verbatim those tags are noise.
 * Collapse them to the command the user actually typed — "/name" plus any args —
 * so a resumed transcript reads like the original prompt. Tag order varies, so
 * each tag is matched independently. Returns null when the text is not a command
 * wrapper, leaving ordinary prompts untouched.
 */
function formatCommandInvocation(text: string): string | null {
  const name = COMMAND_NAME_RE.exec(text)?.[1]?.trim();
  if (!name) {
    return null;
  }
  const args = COMMAND_ARGS_RE.exec(text)?.[1]?.trim() ?? "";
  return args.length > 0 ? `${name} ${args}` : name;
}

/** Default cap on how many trailing messages are re-rendered (see planReplayCommands). */
export const DEFAULT_REPLAY_MESSAGE_LIMIT = 100;

/**
 * Cap the displayed history to the last `maxMessages` and, when truncated,
 * prepend a notice so the user understands earlier messages are hidden. The
 * model still has full prior context via the resume cursor, so capping only
 * affects what is RENDERED — keeping replay dispatch volume bounded (real
 * sessions can be thousands of messages). The notice is just a synthetic
 * leading assistant message, so it reuses the tested mapper unchanged.
 */
export function planReplayCommands(
  messages: ReadonlyArray<ReplaySessionMessage>,
  ctx: ReplayContext,
  maxMessages: number = DEFAULT_REPLAY_MESSAGE_LIMIT,
): ReadonlyArray<ReplayCommand> {
  if (messages.length <= maxMessages) {
    return buildReplayCommands(messages, ctx);
  }
  const sliced = messages.slice(-maxMessages);
  const notice: ReplaySessionMessage = {
    type: "assistant",
    uuid: "resume-truncation-notice",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `_(Resumed session — showing the last ${maxMessages} of ${messages.length} messages. Earlier history is hidden here, but the assistant still has full context.)_`,
        },
      ],
    },
  };
  return buildReplayCommands([notice, ...sliced], ctx);
}

export function buildReplayCommands(
  messages: ReadonlyArray<ReplaySessionMessage>,
  ctx: ReplayContext,
): ReadonlyArray<ReplayCommand> {
  const commands: ReplayCommand[] = [];
  let seq = 0;

  const take = () => {
    const current = seq;
    seq += 1;
    return {
      commandId: CommandId.make(`server:resume-replay:${ctx.sessionId}:${current}`),
      createdAt: DateTime.formatIso(DateTime.makeUnsafe(ctx.baseTimeMs + current)),
    };
  };

  for (const entry of messages) {
    const text = extractText(entry.message);
    if (text.length === 0) {
      continue;
    }
    const messageId = MessageId.make(`resume:${entry.uuid}`);

    if (entry.type === "user") {
      const { commandId, createdAt } = take();
      commands.push({
        type: "thread.message.user.record",
        commandId,
        threadId: ctx.threadId,
        messageId,
        text: formatCommandInvocation(text) ?? text,
        createdAt,
      });
    } else if (entry.type === "assistant") {
      // delta(full text) creates+fills the message (streaming append from
      // empty), complete finalizes it (streaming:false, empty text preserves).
      const delta = take();
      commands.push({
        type: "thread.message.assistant.delta",
        commandId: delta.commandId,
        threadId: ctx.threadId,
        messageId,
        delta: text,
        createdAt: delta.createdAt,
      });
      const complete = take();
      commands.push({
        type: "thread.message.assistant.complete",
        commandId: complete.commandId,
        threadId: ctx.threadId,
        messageId,
        createdAt: complete.createdAt,
      });
    }
  }

  return commands;
}
