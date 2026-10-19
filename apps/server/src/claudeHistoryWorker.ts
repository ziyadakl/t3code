import {
  forkSession,
  getSessionMessages,
  getSubagentMessages,
} from "@anthropic-ai/claude-agent-sdk";
import * as Schema from "effect/Schema";

// Nothing here may run on import: inside the executable `import.meta.main` is
// true for the whole bundle.
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
  const run = () => {
    switch (method) {
      case "getSessionMessages":
        return getSessionMessages(sessionId, options);
      case "forkSession":
        return forkSession(sessionId, options);
      case "getSubagentMessages":
        if (!agentId) throw new Error("Claude subagent id is required.");
        return getSubagentMessages(sessionId, agentId, options);
      default:
        throw new Error("Unknown Claude history operation.");
    }
  };
  process.stdout.write(JSON.stringify(await run()));
}
