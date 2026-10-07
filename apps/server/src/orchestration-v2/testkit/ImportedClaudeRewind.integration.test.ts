import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionImporter from "../../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../../project/AgentSessionScanner.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { ClaudeOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import {
  THREAD_ROLLBACK_AFTER_PROMPT,
  THREAD_ROLLBACK_FIRST_PROMPT,
  THREAD_ROLLBACK_SECOND_PROMPT,
} from "./fixtures/shared.ts";
import { runOrchestratorV2Scenario } from "./OrchestratorScenario.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import {
  materializeReplayTranscriptRuntimeInstructions,
  readProviderReplayTranscript,
} from "./ReplayTranscriptNdjson.ts";

const claudeInstanceId = ProviderInstanceId.make("claudeAgent");

/**
 * The Claude Code transcript a desktop chat left on disk, for the two turns
 * the thread_rollback recording ran before its rewind: same session, same
 * assistant uuids, prompt uuids of our own.
 */
function desktopTranscript(input: {
  readonly sessionId: string;
  readonly assistantUuids: ReadonlyArray<string>;
}): string {
  let parentUuid: string | null = null;
  let second = 0;
  const record = (fields: Record<string, unknown>) => {
    const line = JSON.stringify({
      sessionId: input.sessionId,
      cwd: "/workspace/desktop",
      isSidechain: false,
      parentUuid,
      timestamp: `2026-09-01T10:00:${String(second++).padStart(2, "0")}.000Z`,
      ...fields,
    });
    parentUuid = fields.uuid as string;
    return line;
  };
  return [THREAD_ROLLBACK_FIRST_PROMPT, THREAD_ROLLBACK_SECOND_PROMPT]
    .flatMap((prompt, index) => [
      record({
        type: "user",
        uuid: `desktop-prompt-${index + 1}`,
        message: { role: "user", content: prompt },
      }),
      record({
        type: "assistant",
        uuid: input.assistantUuids[index],
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [
            {
              type: "text",
              text: `rollback fixture ${index === 0 ? "first" : "second"} turn complete`,
            },
          ],
        },
      }),
    ])
    .join("\n");
}

describe("imported Claude desktop chats", () => {
  it.effect("restore conversation resumes the original Claude session before the message", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-imported-rewind-" });
      const raw = yield* readProviderReplayTranscript(
        new URL("./fixtures/thread_rollback/claude_transcript.ndjson", import.meta.url),
      );
      const sessionId = raw.metadata?.nativeSessionId as string;
      const assistantUuids = raw.metadata?.sourceAssistantMessageUuids as ReadonlyArray<string>;
      // The two recorded turns happened in the desktop app. Only the query
      // after the rewind runs here, and the replay fails unless it resumes the
      // recorded session at the first turn's last assistant message.
      const resumeAt = raw.entries.findIndex(
        (entry) => "label" in entry && entry.label === "query.open:resume_at_cursor",
      );
      assert.isAbove(resumeAt, 0);
      const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(
        materializeReplayTranscriptRuntimeInstructions(
          { ...raw, entries: raw.entries.slice(resumeAt) },
          { driver: ProviderDriverKind.make("claudeAgent"), model: "claude-sonnet-4-6" },
        ),
      );

      const threadId = ThreadId.make(`import:${claudeInstanceId}:${sessionId}`);
      const thread = AgentSessionScanner.parseAgentSessionTranscript({
        source: "claudeAgent",
        providerInstanceId: claudeInstanceId,
        fallbackSessionId: sessionId,
        lastActiveAtMs: Date.parse("2026-09-01T10:01:00.000Z"),
        contents: desktopTranscript({ sessionId, assistantUuids }),
      });
      assert.isNotNull(thread);
      const rewound = MessageId.make(`${threadId}:000002`);
      const scenario = {
        name: "thread_rollback/claudeAgent:imported-rewind-conversation",
        transcript,
        commands: [],
        steps: [
          {
            type: "dispatch" as const,
            command: {
              type: "thread.rewind" as const,
              commandId: CommandId.make("command:imported-rewind"),
              threadId,
              messageId: rewound,
              choice: "conversation" as const,
            },
          },
          {
            type: "dispatch" as const,
            command: {
              type: "message.dispatch" as const,
              createdBy: "user" as const,
              creationSource: "web" as const,
              commandId: CommandId.make("command:imported-rewind:after"),
              threadId,
              messageId: MessageId.make("message:imported-rewind:after"),
              text: THREAD_ROLLBACK_AFTER_PROMPT,
              attachments: [],
              dispatchMode: { type: "start_immediately" as const },
            },
          },
          { type: "await_thread_idle" as const, threadId },
        ],
        projectionThreadIds: [threadId],
        runtimePolicyOverride: { cwd },
      };

      const result = yield* Effect.gen(function* () {
        const importer = yield* AgentSessionImporter.AgentSessionImporter;
        yield* importer.importThread({
          projectId: ProjectId.make("project:imported-rewind"),
          workspaceRoot: cwd,
          threadId,
          thread: thread!,
          source: {
            provider: "claudeAgent",
            providerInstanceId: claudeInstanceId,
            providerSessionId: sessionId,
            filePath: `/claude/projects/desktop/${sessionId}.jsonl`,
            size: 1,
            mtimeMs: 1,
            device: 1,
            inode: 1,
            birthtimeMs: 1,
          },
        });
        return yield* runOrchestratorV2Scenario(scenario);
      }).pipe(
        Effect.provide(
          AgentSessionImporter.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(AgentSessionScanner.AgentSessionScanner)({}),
                Layer.mock(ProjectService.ProjectService)({}),
                Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
                  upsert: () => Effect.void,
                  recordImportedTranscript: () => Effect.void,
                }),
                IdAllocator.layer,
              ),
            ),
            Layer.provideMerge(
              ProviderReplayHarness.layerProviderReplay(scenario, ClaudeOrchestratorReplayHarness),
            ),
          ),
        ),
        provideDeterministicTestRuntime,
      );

      const projection = result.projections.get(threadId);
      assert.isDefined(projection);
      assert.deepEqual(
        projection.runs.map((run) => [run.ordinal, run.status]),
        [
          [1, "completed"],
          [2, "rolled_back"],
          [3, "completed"],
        ],
      );
      const rolledBack = new Set(
        projection.runs.filter((run) => run.status === "rolled_back").map((run) => run.id),
      );
      assert.deepEqual(
        projection.messages
          .filter((message) => message.role === "user")
          .filter((message) => message.runId === null || !rolledBack.has(message.runId))
          .map((message) => message.text),
        [THREAD_ROLLBACK_FIRST_PROMPT, THREAD_ROLLBACK_AFTER_PROMPT],
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
