import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  isProviderNativeSubagentThread,
  MessageId,
  ProviderDriverKind,
  type ProviderReplayTranscript,
  type ThreadRewindChoice,
  type ProviderReplayEntry,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as ClaudeAdapterV2 from "../Adapters/ClaudeAdapterV2.ts";
import { ClaudeOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../Orchestrator.ts";
import * as ThreadCodeRewindService from "../ThreadCodeRewindService.ts";
import { userFacingDispatchErrorMessage } from "../UserFacingErrors.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { subagentInput } from "./fixtures/subagent/input.ts";
import { turnInterruptMidToolInput } from "./fixtures/turn_interrupt_mid_tool/input.ts";
import { runOrchestratorV2Scenario } from "./OrchestratorScenario.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "./ReplayRuntimeInstructions.ts";
import { assertClaudeThreadRollbackOutput } from "./fixtures/thread_rollback/claude_output.ts";
import {
  CLAUDE_MODEL_SELECTION,
  materializeFixtureInput,
  projectionFor,
  THREAD_ROLLBACK_AFTER_PROMPT,
  THREAD_ROLLBACK_FIRST_PROMPT,
  THREAD_ROLLBACK_SECOND_PROMPT,
} from "./fixtures/shared.ts";
import {
  findReplayFixture,
  itRunsReplayFixtures,
  runReplayFixture,
  type ReplayFixtureCase,
} from "./ProviderReplayFixtures.ts";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";

const readTranscript = Effect.fn("readClaudeReplayFixture")(function* (file: URL) {
  return yield* readProviderReplayTranscript(file);
}, Effect.provide(NodeServices.layer));

function readClaudeTranscriptFixture(path: string) {
  return readTranscript(new URL(`./fixtures/${path}/claude_transcript.ndjson`, import.meta.url));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type FilesRewound = {
  readonly canRewind: boolean;
  readonly filesChanged?: ReadonlyArray<string>;
  readonly insertions?: number;
  readonly deletions?: number;
  readonly skippedLinks?: number;
  readonly error?: string;
};

/**
 * The thread_rollback recording as a Claude session with file checkpoints: each prompt is
 * echoed with its SDK uuid. After the second turn Claude answers a dry run of the second
 * prompt with `answers.dryRun`, then a restore with `answers.restored` when there is one.
 * Frame shapes are from a live run (SDK 0.3.276, CLI 2.1.292).
 */
function withFileCheckpoints(
  raw: ProviderReplayTranscript,
  answers: { readonly dryRun: FilesRewound; readonly restored?: FilesRewound },
): ProviderReplayTranscript {
  const sessionId = "f9415703-bf61-49e3-8155-1d3fed83f935";
  const echo = (index: number) => ({
    type: "emit_inbound" as const,
    label: `user.replay:${index}`,
    frame: {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "echo" }] },
      parent_tool_use_id: null,
      isReplay: true,
      uuid: `prompt-uuid-${index}`,
      session_id: sessionId,
    },
  });
  const entries: Array<ProviderReplayTranscript["entries"][number]> = [];
  let inits = 0;
  let results = 0;
  for (const entry of raw.entries) {
    entries.push(entry);
    const frame = "frame" in entry && isRecord(entry.frame) ? entry.frame : {};
    if (frame.type === "system" && frame.subtype === "init" && inits < 2) {
      inits += 1;
      entries.push(echo(inits));
    }
    if (frame.type === "result" && ++results === 2) {
      const rewind = (dryRun: boolean, answer: FilesRewound) => [
        {
          type: "expect_outbound" as const,
          label: `query.rewind_files:${dryRun ? "dry-run" : "restore"}`,
          frame: { type: "query.rewind_files", userMessageId: "prompt-uuid-2", dryRun },
        },
        {
          type: "emit_inbound" as const,
          label: "files.rewound",
          frame: { type: "files.rewound", ...answer },
        },
      ];
      entries.push(
        ...rewind(true, answers.dryRun),
        ...(answers.restored === undefined ? [] : rewind(false, answers.restored)),
      );
    }
  }
  return { ...raw, entries } as ProviderReplayTranscript;
}

function metadataString(transcript: ProviderReplayTranscript, key: string): string {
  const value = transcript.metadata?.[key];
  if (typeof value !== "string") {
    throw new Error(`${transcript.scenario} metadata.${key} must be a string.`);
  }
  return value;
}

function runClaudeReplayFixture(input: ReplayFixtureCase) {
  return runReplayFixture({ ...input, harness: ClaudeOrchestratorReplayHarness });
}

describe("Claude Agent SDK replay fixtures", () => {
  itRunsReplayFixtures("claudeAgent", runClaudeReplayFixture);
  it.effect(
    "restores the conversation to before a message in a folder that is not a git repo",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-rewind-no-git-" });
        const raw = yield* readClaudeTranscriptFixture("thread_rollback");
        const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(
          materializeReplayTranscriptRuntimeInstructions(raw, {
            driver: ProviderDriverKind.make("claudeAgent"),
            model: CLAUDE_MODEL_SELECTION.model,
          }),
        );
        const materialized = yield* materializeFixtureInput({
          scenario: "thread_rollback",
          fixtureInput: {
            steps: [
              { type: "message", text: THREAD_ROLLBACK_FIRST_PROMPT },
              { type: "message", text: THREAD_ROLLBACK_SECOND_PROMPT },
              { type: "rewind", targetMessageIndex: 2, choice: "conversation" },
              { type: "message", text: THREAD_ROLLBACK_AFTER_PROMPT },
            ],
          },
          driver: ProviderDriverKind.make("claudeAgent"),
          modelSelection: CLAUDE_MODEL_SELECTION,
        }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
        const scenario = {
          name: "thread_rollback/claudeAgent:rewind-conversation-no-git",
          transcript,
          commands: materialized.commands,
          steps: materialized.steps,
          projectionThreadIds: materialized.projectionThreadIds,
          runtimePolicyOverride: { cwd },
        };
        yield* Effect.gen(function* () {
          // The replay fails unless the next query resumes at the recorded
          // resumeSessionAt, the SDK uuid of the first turn's last assistant message.
          const result = yield* runOrchestratorV2Scenario(scenario);
          assertClaudeThreadRollbackOutput(result, transcript);
          const threadId = materialized.projectionThreadIds[0]!;
          const projection = result.projections.get(threadId);
          assert.isDefined(projection);
          assert.isTrue(
            projection.checkpoints.every((checkpoint) => checkpoint.status !== "ready"),
          );

          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const before = yield* orchestrator.getThreadEventSequence(threadId);
          const [first, rewound] = projection.messages.filter((message) => message.role === "user");
          const refusal = (name: string, messageId: MessageId, choice: ThreadRewindChoice) =>
            orchestrator
              .dispatch({
                type: "thread.rewind",
                commandId: CommandId.make(`command:rewind-refusal:${name}`),
                threadId,
                messageId,
                choice,
              })
              .pipe(Effect.flip, Effect.map(userFacingDispatchErrorMessage));
          assert.equal(
            yield* refusal("rewound", rewound!.id, "conversation"),
            "This message was already rewound.",
          );
          assert.equal(
            yield* refusal("unknown", MessageId.make("message:not-in-thread"), "conversation"),
            "Only a message you sent that started a turn can be rewound.",
          );
          // This recording predates file checkpoints: Claude echoed no prompt uuid.
          assert.equal(
            yield* refusal("code", first!.id, "code"),
            "Claude kept no file snapshots for this message.",
          );
          assert.equal(
            yield* refusal("code-and-conversation", first!.id, "code-and-conversation"),
            "Claude kept no file snapshots for this message.",
          );
          assert.equal(yield* orchestrator.getThreadEventSequence(threadId), before);
          // The menu asks Claude nothing: the replay fails on any SDK call.
          const codeRewind = yield* ThreadCodeRewindService.ThreadCodeRewindServiceV2;
          assert.deepEqual(yield* codeRewind.preview({ threadId, messageId: first!.id }), {
            filesChanged: [],
            insertions: 0,
            deletions: 0,
            unavailableReason: "Claude kept no file snapshots for this message.",
          });
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerProviderReplay(scenario, ClaudeOrchestratorReplayHarness),
          ),
          provideDeterministicTestRuntime,
        );
        assert.equal(
          metadataString(raw, "resumeSessionAt"),
          "3831efb6-619c-4c16-a38a-bf788040ac42",
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  const codeRewindScenario = Effect.fn("codeRewindScenario")(function* (input: {
    readonly name: string;
    readonly choice: ThreadRewindChoice;
    readonly answers: Parameters<typeof withFileCheckpoints>[1];
    readonly sendAfter: boolean;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-rewind-code-no-git-" });
    const raw = withFileCheckpoints(
      yield* readClaudeTranscriptFixture("thread_rollback"),
      input.answers,
    );
    const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(
      materializeReplayTranscriptRuntimeInstructions(
        input.sendAfter
          ? raw
          : {
              ...raw,
              // Restore code keeps the conversation, so no third turn is sent.
              entries: raw.entries.slice(
                0,
                raw.entries.findIndex((entry) => entry.type === "runtime_exit") + 1,
              ),
            },
        { driver: ProviderDriverKind.make("claudeAgent"), model: CLAUDE_MODEL_SELECTION.model },
      ),
    );
    const materialized = yield* materializeFixtureInput({
      scenario: "thread_rollback",
      fixtureInput: {
        steps: [
          { type: "message", text: THREAD_ROLLBACK_FIRST_PROMPT },
          { type: "message", text: THREAD_ROLLBACK_SECOND_PROMPT },
          { type: "rewind", targetMessageIndex: 2, choice: input.choice },
          ...(input.sendAfter
            ? [{ type: "message" as const, text: THREAD_ROLLBACK_AFTER_PROMPT }]
            : []),
        ],
      },
      driver: ProviderDriverKind.make("claudeAgent"),
      modelSelection: CLAUDE_MODEL_SELECTION,
    }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
    const scenario = {
      name: `thread_rollback/claudeAgent:${input.name}`,
      transcript,
      commands: materialized.commands,
      steps: materialized.steps,
      projectionThreadIds: materialized.projectionThreadIds,
      runtimePolicyOverride: { cwd },
    };
    const result = yield* runOrchestratorV2Scenario(scenario).pipe(
      Effect.provide(
        ProviderReplayHarness.layerProviderReplay(scenario, ClaudeOrchestratorReplayHarness),
      ),
      provideDeterministicTestRuntime,
    );
    const projection = result.projections.get(materialized.projectionThreadIds[0]!);
    assert.isDefined(projection);
    return { result, transcript, projection };
  });

  it.effect(
    "restore code puts files back to before a message and keeps the conversation, in a folder that is not a git repo",
    () =>
      Effect.gen(function* () {
        // The replay fails unless Claude is asked to restore the second prompt's uuid.
        const { projection } = yield* codeRewindScenario({
          name: "rewind-code-no-git",
          choice: "code",
          answers: {
            dryRun: {
              canRewind: true,
              filesChanged: ["/tmp/notes.md"],
              insertions: 1,
              deletions: 1,
            },
            restored: { canRewind: true, skippedLinks: 0 },
          },
          sendAfter: false,
        });

        assert.deepEqual(
          projection.runs.map((run) => run.status),
          ["completed", "completed"],
        );
        assert.equal(
          projection.providerTurns.find((turn) => turn.ordinal === 2)?.nativeUserMessageId,
          "prompt-uuid-2",
        );
        assert.deepEqual(projection.thread.rollbackCompletion, {
          requestId: projection.thread.rollbackRequestId!,
        });
        assert.isNull(projection.thread.rollbackFailure ?? null);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("restore code reports files Claude left alone", () =>
    Effect.gen(function* () {
      const { projection } = yield* codeRewindScenario({
        name: "rewind-code-skipped",
        choice: "code",
        answers: {
          dryRun: { canRewind: true, filesChanged: ["/tmp/notes.md"], insertions: 1, deletions: 1 },
          restored: { canRewind: true, skippedLinks: 1 },
        },
        sendAfter: false,
      });

      assert.deepEqual(projection.thread.rollbackCompletion, {
        requestId: projection.thread.rollbackRequestId!,
        notice: "Code restored, but 1 file was left as it is: a link made it unsafe to write.",
      });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("restore code says why when Claude cannot restore, and changes nothing", () =>
    Effect.gen(function* () {
      const { projection } = yield* codeRewindScenario({
        name: "rewind-code-refused",
        choice: "code",
        // Claude refuses the dry run, so nothing is restored.
        answers: {
          dryRun: { canRewind: false, error: "No file checkpoint found for this message." },
        },
        sendAfter: false,
      });

      assert.deepEqual(projection.thread.rollbackFailure, {
        requestId: projection.thread.rollbackRequestId!,
        message: "Could not restore code: No file checkpoint found for this message.",
      });
      assert.isNull(projection.thread.rollbackCompletion ?? null);
      assert.deepEqual(
        projection.runs.map((run) => run.status),
        ["completed", "completed"],
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("restore code refuses up front when Claude changed no files after the message", () =>
    Effect.gen(function* () {
      const { projection } = yield* codeRewindScenario({
        name: "rewind-code-nothing-changed",
        choice: "code",
        answers: {
          dryRun: { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 },
        },
        sendAfter: false,
      });

      assert.deepEqual(projection.thread.rollbackFailure, {
        requestId: projection.thread.rollbackRequestId!,
        message:
          "Could not restore code: Claude changed no files after this message, so there is no code to restore.",
      });
      assert.deepEqual(
        projection.runs.map((run) => run.status),
        ["completed", "completed"],
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "restore code and conversation puts files back, then resumes Claude from before the message",
    () =>
      Effect.gen(function* () {
        const { result, transcript, projection } = yield* codeRewindScenario({
          name: "rewind-code-and-conversation-no-git",
          choice: "code-and-conversation",
          answers: {
            dryRun: {
              canRewind: true,
              filesChanged: ["/tmp/notes.md"],
              insertions: 1,
              deletions: 1,
            },
            restored: { canRewind: true, skippedLinks: 0 },
          },
          sendAfter: true,
        });

        assertClaudeThreadRollbackOutput(result, transcript);
        assert.deepEqual(projection.thread.rollbackCompletion, {
          requestId: projection.thread.rollbackRequestId!,
        });
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "a turn stopped while its last reply only called a tool resumes at that reply after a rewind",
    () =>
      Effect.gen(function* () {
        const raw = yield* readClaudeTranscriptFixture("turn_interrupt_mid_tool");
        const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(
          materializeReplayTranscriptRuntimeInstructions(raw, {
            driver: ProviderDriverKind.make("claudeAgent"),
            model: CLAUDE_MODEL_SELECTION.model,
          }),
        );
        const materialized = yield* materializeFixtureInput({
          scenario: "turn_interrupt_mid_tool",
          fixtureInput: turnInterruptMidToolInput(),
          driver: ProviderDriverKind.make("claudeAgent"),
          modelSelection: CLAUDE_MODEL_SELECTION,
        }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
        const scenario = {
          name: "turn_interrupt_mid_tool/claudeAgent:rewind-cursor",
          transcript,
          commands: materialized.commands,
          steps: materialized.steps,
          projectionThreadIds: materialized.projectionThreadIds,
        };
        const result = yield* runOrchestratorV2Scenario(scenario).pipe(
          Effect.provide(
            ProviderReplayHarness.layerProviderReplay(scenario, ClaudeOrchestratorReplayHarness),
          ),
          provideDeterministicTestRuntime,
        );
        const projection = result.projections.get(materialized.projectionThreadIds[0]!);
        assert.isDefined(projection);
        const [stopped] = projection.providerTurns;
        assert.isDefined(stopped);
        const providerThread = projection.providerThreads.find(
          (candidate) => candidate.id === stopped.providerThreadId,
        )!;

        // The recording's last reply holds only a tool_use block.
        const toolCallReply = "ae2c90aa-4ded-4184-941b-ff32527cc9de";
        assert.equal(stopped.nativeTurnRef?.nativeId, toolCallReply);
        // Rewinding a later message keeps this turn: the session resumes at that reply with
        // its tool call unanswered. Claude Code repairs it on the next prompt (CLI 2.1.292 adds a
        // tool_result "[Tool result missing due to internal error]", ensureToolResultPairing),
        // so the API never sees a tool call without a result.
        assert.equal(
          yield* ClaudeAdapterV2.resolveClaudeRollbackResumeSessionAt({
            providerThread,
            target: { type: "provider_turn", appRunOrdinal: 1, providerTurn: stopped },
            providerThreadTurns: [
              stopped,
              { ...stopped, id: "provider-turn:later" as never, ordinal: stopped.ordinal + 1 },
            ],
          }),
          toolCallReply,
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses messages to a native subagent thread without touching it", () =>
    Effect.gen(function* () {
      const raw = yield* readClaudeTranscriptFixture("subagent");
      const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(
        materializeReplayTranscriptRuntimeInstructions(raw, {
          driver: ProviderDriverKind.make("claudeAgent"),
          model: CLAUDE_MODEL_SELECTION.model,
        }),
      );
      const materialized = yield* materializeFixtureInput({
        scenario: "subagent",
        fixtureInput: subagentInput(),
        driver: ProviderDriverKind.make("claudeAgent"),
        modelSelection: CLAUDE_MODEL_SELECTION,
      }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
      const scenario = {
        name: "subagent/claudeAgent:read-only-child",
        transcript,
        commands: materialized.commands,
        steps: materialized.steps,
        projectionThreadIds: materialized.projectionThreadIds,
      };
      yield* Effect.gen(function* () {
        const result = yield* runOrchestratorV2Scenario(scenario);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const child = [...result.projections.values()].find((projection) =>
          isProviderNativeSubagentThread(projection.thread),
        );
        assert.isDefined(child);
        const before = yield* orchestrator.getThreadEventSequence(child.thread.id);

        const refused = yield* orchestrator
          .dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:subagent:message-native-child"),
            threadId: child.thread.id,
            messageId: MessageId.make("message:subagent:message-native-child"),
            text: "Also check the tests.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          })
          .pipe(Effect.flip);
        assert.equal(refused._tag, "OrchestratorSubagentThreadReadOnlyError");
        assert.equal(
          userFacingDispatchErrorMessage(refused),
          "This subagent is run by its provider and cannot take messages. Message the parent thread instead.",
        );
        assert.equal(yield* orchestrator.getThreadEventSequence(child.thread.id), before);
        const after = yield* orchestrator.getThreadProjection(child.thread.id);
        assert.lengthOf(after.runs, 0);
        assert.deepEqual(after.messages, child.messages);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerProviderReplay(scenario, ClaudeOrchestratorReplayHarness),
        ),
        provideDeterministicTestRuntime,
        Effect.scoped,
      );
    }),
  );

  const afterRootFixture = findReplayFixture("claude_background_subagent_after_root");
  const afterRootProvider = afterRootFixture?.providers[0];
  if (afterRootFixture !== undefined && afterRootProvider !== undefined) {
    const OPEN_TOOL_ID = "toolu_01QDa5jV5g1H9h6QyDfeJohD";
    const SUBAGENT_TASK_ID = "a2995bfced8019363";

    const moveOpenToolBeforeRootResult = (
      move: boolean,
      entries: ReadonlyArray<ProviderReplayEntry>,
    ): ReadonlyArray<ProviderReplayEntry> => {
      if (!move) return entries;
      const toolIndex = entries.findIndex(
        (entry) =>
          entry.type === "emit_inbound" &&
          (entry.frame as Record<string, any>).message?.content?.[0]?.id === OPEN_TOOL_ID,
      );
      const resultIndex = entries.findIndex(
        (entry) => entry.type === "emit_inbound" && entry.label === "result",
      );
      if (toolIndex < 0 || resultIndex < 0) throw new Error("transcript shape changed");
      const toolEntry = entries[toolIndex]!;
      const rest = entries.filter((_, index) => index !== toolIndex);
      return [...rest.slice(0, resultIndex), toolEntry, ...rest.slice(resultIndex)];
    };
    // A subagent's foreground Bash run during the root's turn is tailed like a
    // root call's, so the child's command row streams live.
    const SUBAGENT_BASH_ID = "toolu_01JMN3SSQCHzUTNua9AWdkiH";
    it.effect("streams a subagent's foreground Bash output live during the root turn", () =>
      runClaudeReplayFixture({
        fixtureName: afterRootFixture.name,
        buildInput: afterRootFixture.buildInput,
        driver: {
          ...afterRootProvider,
          assertOutput: (result) => {
            const childThreadId = projectionFor(result, afterRootFixture.name).subagents[0]
              ?.childThreadId;
            assert.exists(childThreadId);
            const command = result.projections
              .get(childThreadId)
              ?.turnItems.find(
                (item) =>
                  item.type === "command_execution" &&
                  JSON.stringify(item.input).includes("SUB_DONE_1"),
              );
            assert.exists(command);
            const streamed = result.commandOutput?.get(command.id);
            assert.exists(streamed, "the subagent's command must stream its output");
            assert.include(streamed.output.text, "SUB_DONE_1");
          },
        },
        transformTranscript: (transcript) => {
          const isBashFrame = (entry: ProviderReplayEntry) => {
            if (entry.type !== "emit_inbound") return false;
            const frame = entry.frame as Record<string, any>;
            return (
              frame.message?.content?.[0]?.id === SUBAGENT_BASH_ID ||
              frame.message?.content?.[0]?.tool_use_id === SUBAGENT_BASH_ID ||
              (frame.type === "system" && frame.tool_use_id === SUBAGENT_BASH_ID)
            );
          };
          // Recorded without the structured result the replay writes output files from.
          const bashFrames = transcript.entries.filter(isBashFrame).map((entry) => {
            const frame = (entry as { readonly frame: Record<string, any> }).frame;
            return frame.type === "user"
              ? {
                  ...entry,
                  frame: { ...frame, tool_use_result: { stdout: "SUB_DONE_1\n", stderr: "" } },
                }
              : entry;
          });
          const rest = transcript.entries.filter((entry) => !isBashFrame(entry));
          const resultIndex = rest.findIndex(
            (entry) => entry.type === "emit_inbound" && entry.label === "result",
          );
          assert.lengthOf(bashFrames, 4, "transcript shape changed");
          assert.isAtLeast(resultIndex, 0, "transcript shape changed");
          return {
            ...transcript,
            entries: [...rest.slice(0, resultIndex), ...bashFrames, ...rest.slice(resultIndex)],
          };
        },
      }),
    );

    // regression: #16486 a background subagent's tool left open while its parent is idle never settled
    it.effect.each([
      ["WebFetch", "while root is idle", "stopped"],
      ["Write", "before root settles", "failed"],
    ] as const)(
      "ends a background subagent's open %s (opened %s) when its notification is %s",
      ([tool, opens, notificationStatus]) =>
        runClaudeReplayFixture({
          fixtureName: afterRootFixture.name,
          buildInput: afterRootFixture.buildInput,
          driver: {
            ...afterRootProvider,
            assertOutput: (result) => {
              const parent = projectionFor(result, afterRootFixture.name);
              assert.deepEqual(
                parent.runs.map((run) => run.status),
                ["completed", "completed"],
              );
              const subagent = parent.subagents[0];
              assert.equal(
                subagent?.status,
                notificationStatus === "stopped" ? "cancelled" : "failed",
              );
              const childThreadId = subagent?.childThreadId;
              assert.exists(childThreadId);
              const child = result.projections.get(childThreadId);
              assert.exists(child);
              const fetches = child.turnItems.filter(
                (item) => item.type === (tool === "WebFetch" ? "web_search" : "file_change"),
              );
              assert.lengthOf(fetches, 1, `the ${tool} reached the child thread`);
              assert.deepEqual(
                {
                  openTool: fetches.map((item) => item.status),
                  openChildNodes: child.nodes
                    .filter(
                      (node) =>
                        node.status === "running" ||
                        node.status === "pending" ||
                        node.status === "waiting",
                    )
                    .map((node) => `${node.kind}:${node.status}`),
                },
                {
                  openTool: [notificationStatus === "stopped" ? "interrupted" : "failed"],
                  openChildNodes: [],
                },
              );
            },
          },
          transformTranscript: (transcript) => ({
            ...transcript,
            entries: moveOpenToolBeforeRootResult(
              opens === "before root settles",
              transcript.entries.flatMap((entry): ReadonlyArray<ProviderReplayEntry> => {
                if (entry.type !== "emit_inbound") return [entry];
                const frame = entry.frame as Record<string, any>;
                if (
                  frame.type === "assistant" &&
                  frame.message?.content?.[0]?.id === OPEN_TOOL_ID
                ) {
                  return [
                    {
                      ...entry,
                      frame: {
                        ...frame,
                        message: {
                          ...frame.message,
                          content: [
                            {
                              ...frame.message.content[0],
                              name: tool,
                              input:
                                tool === "WebFetch"
                                  ? { url: "https://example.com", prompt: "Summarize" }
                                  : { file_path: "notes.txt", content: "SUB_DONE_2" },
                            },
                          ],
                        },
                      },
                    },
                  ];
                }
                if (
                  (frame.type === "system" &&
                    (frame.subtype === "task_started" || frame.subtype === "task_notification") &&
                    frame.tool_use_id === OPEN_TOOL_ID) ||
                  (frame.type === "user" &&
                    frame.message?.content?.[0]?.tool_use_id === OPEN_TOOL_ID) ||
                  (frame.type === "assistant" &&
                    frame.parent_tool_use_id !== null &&
                    frame.message?.content?.[0]?.text === "SUB_FINAL_REPORT")
                ) {
                  return [];
                }
                if (frame.type === "system" && frame.subtype === "task_updated") {
                  return [
                    {
                      ...entry,
                      frame: {
                        ...frame,
                        patch: {
                          ...frame.patch,
                          status: notificationStatus === "stopped" ? "killed" : "failed",
                        },
                      },
                    },
                  ];
                }
                if (
                  frame.type === "system" &&
                  frame.subtype === "task_notification" &&
                  frame.task_id === SUBAGENT_TASK_ID
                ) {
                  return [{ ...entry, frame: { ...frame, status: notificationStatus } }];
                }
                return [entry];
              }),
            ),
          }),
        }),
    );
  }
});
