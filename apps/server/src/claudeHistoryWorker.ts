import {
  forkSession,
  getSessionMessages,
  getSubagentMessages,
} from "@anthropic-ai/claude-agent-sdk";
import * as Schema from "effect/Schema";

// A separate process gives SDK history helpers the provider's environment without
// mutating the server's environment. `claude-history-worker.ts` is the
// standalone entry bundled beside the server for npm installs; the
// single-executable hosts the same function as its `__claude-history`
// subcommand, which has no Node to run a sibling script. Nothing here may run
// on import: inside the executable `import.meta.main` is true for the whole
// bundle.
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
