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
import * as Option from "effect/Option";

import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionImporter from "../../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../../project/AgentSessionScanner.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { ClaudeOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import * as EventSink from "../EventSink.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ThreadCodeRewindService from "../ThreadCodeRewindService.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { claudeTurnRunInT3Code } from "./ImportedThreadFixtures.ts";
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
  readonly prompts?: ReadonlyArray<string>;
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
  return (input.prompts ?? [THREAD_ROLLBACK_FIRST_PROMPT, THREAD_ROLLBACK_SECOND_PROMPT])
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
              text: `rollback fixture ${["first", "second", "third"][index]} turn complete`,
            },
          ],
        },
      }),
    ])
    .join("\n");
}

/**
 * Claude answering a code restore of an imported chat from that session's own
 * file checkpoints: a query resumed only for each call answers the menu's dry
 * run, then the restore's own dry run, then the restore. Frame shapes are from a live dry run on a desktop
 * session (CLI 2.1.280).
 */
function codeRestoreEntries(sessionId: string, promptUuid: string) {
  const open = (label: string) => ({
    type: "expect_outbound" as const,
    label,
    frame: {
      type: "query.open",
      options: {
        model: "claude-sonnet-4-6",
        tools: { type: "preset", preset: "claude_code" },
        // Opened for the call alone, with no prompt and no tools run.
        permissionMode: "default",
        resume: sessionId,
        settings: { showThinkingSummaries: true },
      },
    },
  });
  const rewind = (dryRun: boolean, answer: Record<string, unknown>) => [
    {
      type: "expect_outbound" as const,
      label: `query.rewind_files:${dryRun ? "dry-run" : "restore"}`,
      frame: { type: "query.rewind_files", userMessageId: promptUuid, dryRun },
    },
    {
      type: "emit_inbound" as const,
      label: "files.rewound",
      frame: { type: "files.rewound", ...answer },
    },
  ];
  const changes = {
    canRewind: true,
    filesChanged: ["/workspace/desktop/notes.md"],
    insertions: 0,
    deletions: 16,
  };
  return [
    open("query.open:rewind-preview"),
    ...rewind(true, changes),
    // The restore checks again before it touches a file.
    open("query.open:rewind-restore-check"),
    ...rewind(true, changes),
    open("query.open:rewind-restore"),
    ...rewind(false, { canRewind: true, skippedLinks: 0 }),
  ];
}

/**
 * Imports a desktop chat holding `imported` of the recording's prompts, adds
 * `ranInT3Code` as a turn T3 Code ran on it before rewind points existed,
 * heals it, then rewinds the message `rewound` picks and sends a prompt.
 * Only the query after the rewind runs, and the replay fails unless it
 * resumes the recorded session at the first turn's last assistant message.
 */
const runImportedRewind = (input: {
  readonly name: string;
  readonly imported: ReadonlyArray<string>;
  readonly ranInT3Code?: { readonly prompt: string; readonly nativeReplyIndex: number };
  readonly rewound: (threadId: ThreadId) => MessageId;
  /**
   * Restore code instead: the menu first asks what a restore would change,
   * then Claude restores the files; nothing is sent after.
   */
  readonly restoresCode?: boolean;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-imported-rewind-" });
    const raw = yield* readProviderReplayTranscript(
      new URL("./fixtures/thread_rollback/claude_transcript.ndjson", import.meta.url),
    );
    const sessionId = raw.metadata?.nativeSessionId as string;
    const assistantUuids = raw.metadata?.sourceAssistantMessageUuids as ReadonlyArray<string>;
    const resumeAt = raw.entries.findIndex(
      (entry) => "label" in entry && entry.label === "query.open:resume_at_cursor",
    );
    assert.isAbove(resumeAt, 0);
    const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(
      materializeReplayTranscriptRuntimeInstructions(
        {
          ...raw,
          entries:
            input.restoresCode === true
              ? codeRestoreEntries(sessionId, "desktop-prompt-2")
              : raw.entries.slice(resumeAt),
        },
        { driver: ProviderDriverKind.make("claudeAgent"), model: "claude-sonnet-4-6" },
      ),
    );

    const threadId = ThreadId.make(`import:${claudeInstanceId}:${sessionId}`);
    const rewindCommandId = CommandId.make("command:imported-rewind");
    const parse = (prompts: ReadonlyArray<string>) => {
      const thread = AgentSessionScanner.parseAgentSessionTranscript({
        source: "claudeAgent",
        providerInstanceId: claudeInstanceId,
        fallbackSessionId: sessionId,
        lastActiveAtMs: Date.parse("2026-09-01T10:01:00.000Z"),
        contents: desktopTranscript({ sessionId, assistantUuids, prompts }),
        allMessages: true,
      });
      assert.isNotNull(thread);
      return thread!;
    };
    const imported = parse(input.imported);
    // T3 Code continues the session, so its turn follows in the transcript.
    const whole = parse(
      input.ranInT3Code === undefined
        ? input.imported
        : [...input.imported, input.ranInT3Code.prompt],
    );
    const source = {
      provider: "claudeAgent" as const,
      providerInstanceId: claudeInstanceId,
      providerSessionId: sessionId,
      filePath: `/claude/projects/desktop/${sessionId}.jsonl`,
      size: 1,
      mtimeMs: 1,
      device: 1,
      inode: 1,
      birthtimeMs: 1,
    };
    const scenario = {
      name: `thread_rollback/claudeAgent:${input.name}`,
      transcript,
      commands: [],
      steps: [
        {
          type: "dispatch" as const,
          command: {
            type: "thread.rewind" as const,
            commandId: rewindCommandId,
            threadId,
            messageId: input.rewound(threadId),
            choice: input.restoresCode === true ? ("code" as const) : ("conversation" as const),
          },
        },
        ...(input.restoresCode === true
          ? [
              {
                type: "await_rollback_outcome" as const,
                threadId,
                requestId: rewindCommandId,
              },
            ]
          : [
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
            ]),
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
        thread:
          input.ranInT3Code === undefined
            ? imported
            : {
                // Imported before imports kept transcript uuids.
                ...imported,
                messages: imported.messages.map(
                  ({ nativeUserMessageId: _id, nativeTurnId: _turn, ...message }) => message,
                ),
              },
        source,
      });
      if (input.ranInT3Code !== undefined) {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const [providerThread] = (yield* orchestrator.getThreadRecords(threadId, [
          "providerThreads",
        ])).providerThreads;
        yield* (yield* EventSink.EventSinkV2).write({
          events: claudeTurnRunInT3Code({
            providerThread: providerThread!,
            ordinal: 1,
            providerTurnOrdinal: 1,
            prompt: input.ranInT3Code.prompt,
            reply: "Done in T3 Code.",
            nativeReplyId: assistantUuids[input.ranInT3Code.nativeReplyIndex]!,
            at: "2026-09-02T09:00:00.000Z",
          }),
        });
        assert.equal(yield* importer.healImportedRewindPoints(), 1);
      }
      const preview =
        input.restoresCode === true
          ? yield* (yield* ThreadCodeRewindService.ThreadCodeRewindServiceV2).preview({
              threadId,
              messageId: input.rewound(threadId),
            })
          : null;
      return { preview, ...(yield* runOrchestratorV2Scenario(scenario)) };
    }).pipe(
      Effect.provide(
        AgentSessionImporter.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(AgentSessionScanner.AgentSessionScanner)({
                readThread: () => Effect.succeed(Option.some({ thread: whole, source })),
              }),
              Layer.mock(ProjectService.ProjectService)({}),
              Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
                upsert: () => Effect.void,
                recordImportedTranscript: () => Effect.void,
                list: () =>
                  Effect.succeed([
                    {
                      threadId,
                      providerName: "claudeAgent",
                      runtimePayload: { cwd, importedTranscripts: [source] },
                    },
                  ] as never),
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
    const rolledBack = new Set(
      projection.runs.filter((run) => run.status === "rolled_back").map((run) => run.id),
    );
    return {
      ...(result.preview === null ? {} : { preview: result.preview }),
      ...(input.restoresCode === true
        ? { rollbackCompletion: projection.thread.rollbackCompletion ?? null }
        : {}),
      runs: projection.runs
        .toSorted((left, right) => left.ordinal - right.ordinal)
        .map((run) => [run.ordinal, run.status]),
      shownPrompts: projection.messages
        .filter((message) => message.role === "user")
        .filter((message) => message.runId === null || !rolledBack.has(message.runId))
        .map((message) => message.text),
    };
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("imported Claude desktop chats", () => {
  it.effect("restore conversation resumes the original Claude session before the message", () =>
    Effect.gen(function* () {
      const result = yield* runImportedRewind({
        name: "imported-rewind-conversation",
        imported: [THREAD_ROLLBACK_FIRST_PROMPT, THREAD_ROLLBACK_SECOND_PROMPT],
        rewound: (threadId) => MessageId.make(`${threadId}:000002`),
      });
      assert.deepEqual(result, {
        runs: [
          [1, "completed"],
          [2, "rolled_back"],
          [3, "completed"],
        ],
        shownPrompts: [THREAD_ROLLBACK_FIRST_PROMPT, THREAD_ROLLBACK_AFTER_PROMPT],
      });
    }),
  );

  it.effect("rewinding T3 Code's first turn in a healed chat resumes after the import", () =>
    Effect.gen(function* () {
      const result = yield* runImportedRewind({
        name: "imported-rewind-t3-turn",
        imported: [THREAD_ROLLBACK_FIRST_PROMPT],
        ranInT3Code: { prompt: THREAD_ROLLBACK_SECOND_PROMPT, nativeReplyIndex: 1 },
        rewound: () => MessageId.make("message:t3-code-turn-1:prompt"),
      });
      assert.deepEqual(result, {
        // T3 Code's turn keeps ordinal 1; the imported turn healed after it is 2.
        runs: [
          [1, "rolled_back"],
          [2, "completed"],
          [3, "completed"],
        ],
        shownPrompts: [THREAD_ROLLBACK_FIRST_PROMPT, THREAD_ROLLBACK_AFTER_PROMPT],
      });
    }),
  );

  it.effect("rewinding an imported prompt of a healed chat also undoes T3 Code's turns", () =>
    Effect.gen(function* () {
      const result = yield* runImportedRewind({
        name: "imported-rewind-before-t3-turn",
        imported: [THREAD_ROLLBACK_FIRST_PROMPT, THREAD_ROLLBACK_SECOND_PROMPT],
        ranInT3Code: { prompt: "Tighten the wording", nativeReplyIndex: 1 },
        rewound: (threadId) => MessageId.make(`${threadId}:000002`),
      });
      assert.deepEqual(result, {
        runs: [
          [1, "rolled_back"],
          [2, "completed"],
          [3, "rolled_back"],
          [4, "completed"],
        ],
        shownPrompts: [THREAD_ROLLBACK_FIRST_PROMPT, THREAD_ROLLBACK_AFTER_PROMPT],
      });
    }),
  );

  it.effect(
    "an imported chat not yet continued offers and restores code from its own file checkpoints",
    () =>
      Effect.gen(function* () {
        const result = yield* runImportedRewind({
          name: "imported-rewind-code",
          imported: [THREAD_ROLLBACK_FIRST_PROMPT, THREAD_ROLLBACK_SECOND_PROMPT],
          rewound: (threadId) => MessageId.make(`${threadId}:000002`),
          restoresCode: true,
        });
        assert.deepEqual(result, {
          preview: { filesChanged: ["/workspace/desktop/notes.md"], insertions: 0, deletions: 16 },
          rollbackCompletion: { requestId: CommandId.make("command:imported-rewind") },
          // The conversation stays as it is.
          runs: [
            [1, "completed"],
            [2, "completed"],
          ],
          shownPrompts: [THREAD_ROLLBACK_FIRST_PROMPT, THREAD_ROLLBACK_SECOND_PROMPT],
        });
      }),
  );
});
