import {
  forkSession,
  getSessionMessages,
  getSubagentMessages,
} from "@anthropic-ai/claude-agent-sdk";
import * as Schema from "effect/Schema";

// Bundled import.meta.main is always true; imports must have no side effects.
const decodeHistoryOptions = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      agentId: Schema.optionalKey(Schema.String),
      dir: Schema.optionalKey(Schema.String),
      includeSystemMessages: Schema.optionalKey(Schema.Boolean),
      limit: Schema.optionalKey(Schema.Number),
      upToMessageId: Schema.optionalKey(Schema.String),
    }),
  ),
);

export async function runClaudeHistoryWorker(
  method: string | undefined,
  sessionId: string | undefined,
  rawOptions: string | undefined,
): Promise<void> {
  const { agentId, ...options } = decodeHistoryOptions(rawOptions ?? "{}");
  if (!sessionId) throw new Error("Claude history session id is required.");
  const run = async () => {
    switch (method) {
      case "getSessionMessages":
        return getSessionMessages(sessionId, options);
      case "forkSession": {
        const forked = await forkSession(sessionId, options);
        const headMessageId = await getSessionMessages(forked.sessionId, options)
          .then((messages) => messages.at(-1)?.uuid)
          .catch(() => undefined);
        return headMessageId === undefined ? forked : { ...forked, headMessageId };
      }
      case "getSubagentMessages":
        if (!agentId) throw new Error("Claude subagent id is required.");
        return getSubagentMessages(sessionId, agentId, options);
      default:
        throw new Error("Unknown Claude history operation.");
    }
  };
  process.stdout.write(JSON.stringify(await run()));
}
