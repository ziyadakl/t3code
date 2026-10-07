import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  isProviderNativeSubagentThread,
  MessageId,
  ProviderDriverKind,
  type ProviderReplayTranscript,
  type ThreadRewindChoice,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { classifyClaudeNativeTool } from "../Adapters/ClaudeAdapterV2.ts";
import { ClaudeOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as Orchestrator from "../Orchestrator.ts";
import { userFacingDispatchErrorMessage } from "../UserFacingErrors.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "./fixtures/index.ts";
import { subagentInput } from "./fixtures/subagent/input.ts";
import { runOrchestratorV2Scenario } from "./OrchestratorScenario.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "./ReplayTranscriptNdjson.ts";
import { assertClaudeThreadRollbackOutput } from "./fixtures/thread_rollback/claude_output.ts";
import {
  CLAUDE_MODEL_SELECTION,
  materializeFixtureInput,
  THREAD_ROLLBACK_AFTER_PROMPT,
  THREAD_ROLLBACK_FIRST_PROMPT,
  THREAD_ROLLBACK_SECOND_PROMPT,
} from "./fixtures/shared.ts";
import {
  THREAD_FORK_NATIVE_CONTINUE_FORK_MARKER,
  THREAD_FORK_NATIVE_CONTINUE_RECALL,
  THREAD_FORK_NATIVE_CONTINUE_SOURCE_MARKER,
  THREAD_MERGE_BACK_FORK_MARKER,
  THREAD_MERGE_BACK_RECALL,
  THREAD_MERGE_BACK_SIBLINGS_FIRST_MARKER,
  THREAD_MERGE_BACK_SIBLINGS_RECALL,
  THREAD_MERGE_BACK_SIBLINGS_SECOND_MARKER,
  THREAD_MERGE_BACK_SIBLINGS_SOURCE_MARKER,
  THREAD_MERGE_BACK_SOURCE_MARKER,
} from "./fixtures/shared.ts";
import { readProviderReplayTranscript } from "./ReplayTranscriptNdjson.ts";

const readTranscript = Effect.fn("readClaudeReplayFixture")(function* (file: URL) {
  return yield* readProviderReplayTranscript(file);
}, Effect.provide(NodeServices.layer));

function readClaudeTranscriptFixture(path: string) {
  return readTranscript(new URL(`./fixtures/${path}/claude_transcript.ndjson`, import.meta.url));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The thread_rollback recording, as a Claude session with file checkpoints on
 * answers it: each prompt is echoed with its SDK uuid, and the first restore
 * after the second turn gets `restored`. Frame shapes are from a live run
 * (SDK 0.3.276, CLI 2.1.292); the recording predates checkpoints.
 */
function withFileCheckpoints(
  raw: ProviderReplayTranscript,
  restored: {
    readonly canRewind: boolean;
    readonly skippedLinks?: number;
    readonly error?: string;
  },
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
      entries.push(
        {
          type: "expect_outbound",
          label: "query.rewind_files",
          frame: { type: "query.rewind_files", userMessageId: "prompt-uuid-2", dryRun: false },
        },
        {
          type: "emit_inbound",
          label: "files.rewound",
          frame: { type: "files.rewound", ...restored },
        },
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

function metadataStringArray(
  transcript: ProviderReplayTranscript,
  key: string,
): ReadonlyArray<string> {
  const value = transcript.metadata?.[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${transcript.scenario} metadata.${key} must be a string array.`);
  }
  return value;
}

type FramedReplayEntry = Extract<
  ProviderReplayTranscript["entries"][number],
  { readonly frame: unknown }
>;

function frameRecord(entry: FramedReplayEntry): Record<string, unknown> {
  if (!isRecord(entry.frame)) {
    throw new Error("Replay entry frame must be an object.");
  }
  return entry.frame;
}

function findEntryFrame(
  transcript: ProviderReplayTranscript,
  label: string,
): Record<string, unknown> {
  const entry = transcript.entries.find(
    (candidate): candidate is FramedReplayEntry =>
      "label" in candidate && candidate.label === label && "frame" in candidate,
  );
  assert.isDefined(entry, `${transcript.scenario} must include replay entry ${label}`);
  return frameRecord(entry);
}

function successResultTexts(transcript: ProviderReplayTranscript): ReadonlyArray<string> {
  return transcript.entries.flatMap((entry) => {
    if (entry.type !== "emit_inbound" || !isRecord(entry.frame)) {
      return [];
    }
    if (entry.frame.type !== "result" || entry.frame.subtype !== "success") {
      return [];
    }
    return typeof entry.frame.result === "string" ? [entry.frame.result] : [];
  });
}

function claudeToolUseNamesFromTranscript(
  transcript: ProviderReplayTranscript,
): ReadonlyArray<string> {
  return transcript.entries.flatMap((entry) => {
    if (
      entry.type !== "emit_inbound" ||
      !isRecord(entry.frame) ||
      entry.frame.type !== "assistant"
    ) {
      return [];
    }

    const message = entry.frame.message;
    const content = isRecord(message) ? message.content : undefined;
    if (!Array.isArray(content)) {
      return [];
    }

    return content.flatMap((part) =>
      isRecord(part) &&
      typeof part.id === "string" &&
      typeof part.name === "string" &&
      "input" in part
        ? [part.name]
        : [],
    );
  });
}

describe("Claude Agent SDK replay fixtures", () => {
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
    readonly restored: Parameters<typeof withFileCheckpoints>[1];
    readonly sendAfter: boolean;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-rewind-code-no-git-" });
    const raw = withFileCheckpoints(
      yield* readClaudeTranscriptFixture("thread_rollback"),
      input.restored,
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
          restored: { canRewind: true, skippedLinks: 0 },
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
        restored: { canRewind: true, skippedLinks: 1 },
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
        restored: { canRewind: false, error: "No file checkpoint found for this message." },
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

  it.effect(
    "restore code and conversation puts files back, then resumes Claude from before the message",
    () =>
      Effect.gen(function* () {
        const { result, transcript, projection } = yield* codeRewindScenario({
          name: "rewind-code-and-conversation-no-git",
          choice: "code-and-conversation",
          restored: { canRewind: true, skippedLinks: 0 },
          sendAfter: true,
        });

        assertClaudeThreadRollbackOutput(result, transcript);
        assert.deepEqual(projection.thread.rollbackCompletion, {
          requestId: projection.thread.rollbackRequestId!,
        });
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
        // The wire error carries this text to the web toast and mobile outbox.
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

  it.effect("classifies every Claude fixture tool use through the native tool table", () =>
    Effect.gen(function* () {
      const unknownToolNames = new Set<string>();
      const seenToolNames = new Set<string>();

      for (const fixture of ORCHESTRATOR_REPLAY_FIXTURES) {
        for (const provider of fixture.providers) {
          if (provider.driver !== "claudeAgent") {
            continue;
          }

          const transcript = yield* readTranscript(provider.transcriptFile);
          for (const toolName of claudeToolUseNamesFromTranscript(transcript)) {
            seenToolNames.add(toolName);
            const classification = classifyClaudeNativeTool(toolName);
            // MCP tools are open-ended and deliberately become dynamic tools.
            if (!classification.known && !toolName.startsWith("mcp__")) {
              unknownToolNames.add(`${fixture.name}:${toolName}`);
            }
          }
        }
      }

      assert.isAtLeast(seenToolNames.size, 1, "expected Claude fixtures to contain tool uses");
      assert.deepEqual([...unknownToolNames], []);
    }),
  );

  it.effect("keeps unregistered native conversation-state transcripts reviewable", () =>
    Effect.gen(function* () {
      const rollback = yield* readClaudeTranscriptFixture("thread_rollback");
      assert.equal(rollback.metadata?.queryMode, "resume_at_cursor");
      const rollbackCursor = metadataString(rollback, "resumeSessionAt");
      const rollbackResumeFrame = findEntryFrame(rollback, "query.open:resume_at_cursor");
      const rollbackResumeOptions = rollbackResumeFrame.options;
      if (!isRecord(rollbackResumeOptions)) {
        throw new Error("Rollback resume query.open options must be an object.");
      }
      assert.equal(rollbackResumeOptions.resumeSessionAt, rollbackCursor);
      const rollbackFinalText = successResultTexts(rollback).at(-1) ?? "";
      assert.include(rollbackFinalText, "rollback fixture first turn complete");
      assert.notInclude(rollbackFinalText, "rollback fixture second turn complete");

      const latestFork = yield* readClaudeTranscriptFixture("thread_fork_native");
      assert.equal(latestFork.metadata?.queryMode, "fork_session");
      const latestForkedSessionId = metadataString(latestFork, "forkedNativeSessionId");
      const latestForkedFrame = findEntryFrame(latestFork, "session.forked");
      assert.equal(latestForkedFrame.sessionId, latestForkedSessionId);

      const priorFork = yield* readClaudeTranscriptFixture("thread_fork_native_prior_turn");
      assert.equal(priorFork.metadata?.queryMode, "fork_session_prior_turn");
      const priorForkCursor = metadataString(priorFork, "forkUpToMessageId");
      const priorForkFrame = findEntryFrame(priorFork, "session.fork");
      const priorForkOptions = priorForkFrame.options;
      if (!isRecord(priorForkOptions)) {
        throw new Error("Prior-turn fork options must be an object.");
      }
      assert.equal(priorForkOptions.upToMessageId, priorForkCursor);
      const priorForkFinalText = successResultTexts(priorFork).at(-1) ?? "";
      assert.include(priorForkFinalText, "fork boundary alpha");
      assert.notInclude(priorForkFinalText, "fork boundary beta");

      const continuedFork = yield* readClaudeTranscriptFixture("thread_fork_native_continue");
      assert.equal(continuedFork.metadata?.queryMode, "fork_session_continue");
      const continuedForkSessionId = metadataString(continuedFork, "forkedNativeSessionId");
      const continuedForkOpenFrame = findEntryFrame(continuedFork, "query.open:fork");
      const continuedForkOptions = continuedForkOpenFrame.options;
      if (!isRecord(continuedForkOptions)) {
        throw new Error("Continued fork query.open options must be an object.");
      }
      assert.equal(continuedForkOptions.resume, continuedForkSessionId);
      const continuedForkResults = successResultTexts(continuedFork);
      assert.deepEqual(continuedForkResults.slice(0, 2), [
        "source marker stored",
        "fork marker stored",
      ]);
      assert.equal(
        continuedForkResults.at(-1)?.replace(/\s*\|\s*/u, "|"),
        THREAD_FORK_NATIVE_CONTINUE_RECALL,
      );
      const recallPromptFrame = findEntryFrame(continuedFork, "prompt.offer:3");
      const recallMessage = recallPromptFrame.message;
      const recallMessageBody = isRecord(recallMessage) ? recallMessage.message : undefined;
      const recallPrompt =
        isRecord(recallMessageBody) && typeof recallMessageBody.content === "string"
          ? recallMessageBody.content
          : "";
      assert.notInclude(recallPrompt, THREAD_FORK_NATIVE_CONTINUE_SOURCE_MARKER);
      assert.notInclude(recallPrompt, THREAD_FORK_NATIVE_CONTINUE_FORK_MARKER);

      const siblingForks = yield* readClaudeTranscriptFixture("thread_fork_native_siblings");
      assert.equal(siblingForks.metadata?.queryMode, "fork_session_siblings");
      const siblingSessionIds = metadataStringArray(siblingForks, "forkedNativeSessionIds");
      assert.lengthOf(siblingSessionIds, 2);
      assert.notEqual(siblingSessionIds[0], siblingSessionIds[1]);
      const siblingResults = successResultTexts(siblingForks).map((text) =>
        text.replace(/\s*\|\s*/u, "|"),
      );
      assert.deepEqual(siblingResults, [
        "sibling source stored",
        "sibling-source-8R3D|sibling-first-5L2P",
        "sibling-source-8R3D|sibling-second-9N6C",
      ]);
      assert.notInclude(siblingResults[1] ?? "", "sibling-second-9N6C");
      assert.notInclude(siblingResults[2] ?? "", "sibling-first-5L2P");

      const mergeBack = yield* readClaudeTranscriptFixture("thread_merge_back_continue");
      assert.equal(mergeBack.metadata?.queryMode, "fork_session_merge_back");
      const mergeBackSourceSessionId = metadataString(mergeBack, "nativeSessionId");
      const mergeBackContinuationFrame = findEntryFrame(
        mergeBack,
        "query.open:source-continuation",
      );
      const mergeBackContinuationOptions = mergeBackContinuationFrame.options;
      if (!isRecord(mergeBackContinuationOptions)) {
        throw new Error("Merge-back source continuation options must be an object.");
      }
      assert.equal(mergeBackContinuationOptions.resume, mergeBackSourceSessionId);
      const mergeBackRecallFrame = findEntryFrame(mergeBack, "prompt.offer:4");
      const mergeBackRecallMessage = mergeBackRecallFrame.message;
      const mergeBackRecallBody = isRecord(mergeBackRecallMessage)
        ? mergeBackRecallMessage.message
        : undefined;
      const mergeBackRecallPrompt =
        isRecord(mergeBackRecallBody) && typeof mergeBackRecallBody.content === "string"
          ? mergeBackRecallBody.content
          : "";
      assert.notInclude(mergeBackRecallPrompt, THREAD_MERGE_BACK_SOURCE_MARKER);
      assert.notInclude(mergeBackRecallPrompt, THREAD_MERGE_BACK_FORK_MARKER);
      assert.equal(
        successResultTexts(mergeBack)
          .at(-1)
          ?.replace(/\s*\|\s*/gu, "|"),
        THREAD_MERGE_BACK_RECALL,
      );

      const siblingMergeBack = yield* readClaudeTranscriptFixture("thread_merge_back_siblings");
      assert.equal(siblingMergeBack.metadata?.queryMode, "fork_session_merge_back_siblings");
      const siblingMergeSessionIds = metadataStringArray(
        siblingMergeBack,
        "forkedNativeSessionIds",
      );
      assert.lengthOf(siblingMergeSessionIds, 2);
      assert.notEqual(siblingMergeSessionIds[0], siblingMergeSessionIds[1]);
      const siblingMergeRecallFrame = findEntryFrame(siblingMergeBack, "prompt.offer:6");
      const siblingMergeRecallMessage = siblingMergeRecallFrame.message;
      const siblingMergeRecallBody = isRecord(siblingMergeRecallMessage)
        ? siblingMergeRecallMessage.message
        : undefined;
      const siblingMergeRecallPrompt =
        isRecord(siblingMergeRecallBody) && typeof siblingMergeRecallBody.content === "string"
          ? siblingMergeRecallBody.content
          : "";
      assert.notInclude(siblingMergeRecallPrompt, THREAD_MERGE_BACK_SIBLINGS_SOURCE_MARKER);
      assert.notInclude(siblingMergeRecallPrompt, THREAD_MERGE_BACK_SIBLINGS_FIRST_MARKER);
      assert.notInclude(siblingMergeRecallPrompt, THREAD_MERGE_BACK_SIBLINGS_SECOND_MARKER);
      assert.equal(
        successResultTexts(siblingMergeBack)
          .at(-1)
          ?.replace(/\s*\|\s*/gu, "|"),
        THREAD_MERGE_BACK_SIBLINGS_RECALL,
      );

      const forkLocalRollback = yield* readClaudeTranscriptFixture(
        "thread_fork_native_fork_local_rollback",
      );
      assert.equal(forkLocalRollback.metadata?.queryMode, "fork_session_resume_at_fork_cursor");
      const forkLocalRollbackCursor = metadataString(forkLocalRollback, "resumeSessionAt");
      const forkLocalRollbackFrame = findEntryFrame(
        forkLocalRollback,
        "query.open:fork-resume-at-cursor",
      );
      const forkLocalRollbackOptions = forkLocalRollbackFrame.options;
      if (!isRecord(forkLocalRollbackOptions)) {
        throw new Error("Fork-local rollback resume query.open options must be an object.");
      }
      assert.equal(forkLocalRollbackOptions.resumeSessionAt, forkLocalRollbackCursor);
      const forkLocalRollbackFinalText = successResultTexts(forkLocalRollback).at(-1) ?? "";
      assert.include(forkLocalRollbackFinalText, "fork local source alpha");
      assert.include(forkLocalRollbackFinalText, "fork local first");
      assert.notInclude(forkLocalRollbackFinalText, "fork local second");
    }),
  );
});
