import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProviderEventLoggers from "../../provider/ProviderEventLoggers.ts";
import { ClaudeAgentSdkQueryRunner, layerQueryRunner } from "./ClaudeAdapterV2.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const sessionId = "6f0c6a52-1d5e-4f39-9a51-3c1f6f0b2a11";
const userMessageId = "0b8c2a47-5f0e-4a8f-9a55-0c6f7f6d1e01";
const assistantMessageId = "4a1d9e3c-7b2f-4c6a-8e10-2d5b9f3c7a02";
const subagentId = "a1b2c3d4e5f6";
const subagentToolUseId = "toolu_01SubagentLaunch";

// The SDK's session helpers find transcripts under CLAUDE_CONFIG_DIR, read from
// the process environment and cached on first use. A provider instance with its
// own Claude home keeps its transcripts there, not wherever the server's own
// environment points, so the runner must reach them through that instance's
// environment. The server's home here is an empty directory.
const writeHomes = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfigDir = yield* fs.makeTempDirectory({ prefix: "t3-claude-server-" });
  process.env.CLAUDE_CONFIG_DIR = serverConfigDir;
  const configDir = yield* fs.makeTempDirectory({ prefix: "t3-claude-provider-" });
  const projectDir = path.join(configDir, "projects", "-tmp-t3-claude-project");
  const subagentsDir = path.join(projectDir, sessionId, "subagents");
  const base = { sessionId, cwd: "/tmp/t3-claude-project", timestamp: "2026-10-08T00:00:00.000Z" };
  yield* fs.makeDirectory(subagentsDir, { recursive: true });
  yield* fs.writeFileString(
    path.join(projectDir, `${sessionId}.jsonl`),
    [
      {
        ...base,
        type: "user",
        uuid: userMessageId,
        parentUuid: null,
        message: { role: "user", content: "hello" },
      },
      {
        ...base,
        type: "assistant",
        uuid: assistantMessageId,
        parentUuid: userMessageId,
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      },
    ]
      .map((line) => encodeJson(line))
      .join("\n") + "\n",
  );
  yield* fs.writeFileString(
    path.join(subagentsDir, `agent-${subagentId}.jsonl`),
    encodeJson({
      ...base,
      type: "user",
      uuid: "9c3e1f2a-6d4b-4e8a-b7c1-5f2e8d9a0b03",
      parentUuid: null,
      isSidechain: true,
      agentId: subagentId,
      message: { role: "user", content: "subagent task" },
    }) + "\n",
  );
  yield* fs.writeFileString(
    path.join(subagentsDir, `agent-${subagentId}.meta.json`),
    encodeJson({ agentType: "general-purpose", toolUseId: subagentToolUseId }),
  );
  return { serverConfigDir, configDir, projectDir };
});

const runnerLayer = layerQueryRunner.pipe(
  Layer.provide(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

describe("ClaudeAgentSdkQueryRunner provider Claude home", () => {
  it.effect("forks a session stored in the provider's Claude home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { serverConfigDir, configDir, projectDir } = yield* writeHomes;
      const runner = yield* ClaudeAgentSdkQueryRunner;

      const forked = yield* runner.forkSession({
        sessionId,
        options: { upToMessageId: assistantMessageId },
        environment: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
        threadId: ThreadId.make("thread-claude-fork-provider-home"),
        providerSessionId: ProviderSessionId.make("provider-session-claude-fork"),
      });

      assert.notStrictEqual(forked.sessionId, sessionId);
      assert.isTrue(yield* fs.exists(path.join(projectDir, `${forked.sessionId}.jsonl`)));
      assert.deepStrictEqual(yield* fs.readDirectory(serverConfigDir), []);
    }).pipe(Effect.provide(runnerLayer)),
  );

  it.effect("finds a subagent's launch in the provider's Claude home", () =>
    Effect.gen(function* () {
      const { configDir } = yield* writeHomes;
      const runner = yield* ClaudeAgentSdkQueryRunner;

      const toolUseId = yield* runner.subagentLaunchToolUseId({
        sessionId,
        agentId: subagentId,
        dir: null,
        environment: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
        threadId: ThreadId.make("thread-claude-subagent-provider-home"),
        providerSessionId: ProviderSessionId.make("provider-session-claude-subagent"),
      });

      assert.strictEqual(toolUseId, subagentToolUseId);
    }).pipe(Effect.provide(runnerLayer)),
  );
});
