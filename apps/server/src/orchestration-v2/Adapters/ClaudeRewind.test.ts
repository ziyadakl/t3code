/** Claude message rewind: restoring files, and where a rewind resumes the conversation. */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClaudeSettings,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

const ADAPTER_TEST_LAYER = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
  NodeCrypto.layer,
);

const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});

const CLAUDE_TEST_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
  options: [{ id: "effort", value: "ultrathink" }],
} satisfies ModelSelection;
const CLAUDE_TEST_RUNTIME_POLICY = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

function makeClaudeTestAppThread(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Claude attachment test",
    providerInstanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: input.providerThread.id,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function makeClaudeTestTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly attemptId: RunAttemptId;
  readonly text: string;
  readonly attachments: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["attachments"];
  readonly providerTurnOrdinal?: number;
  readonly nativeThreadHasTurns?: boolean;
  readonly messageCreatedBy?: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["createdBy"];
  readonly messageCreationSource?: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["creationSource"];
  readonly modelSelection?: ModelSelection;
  readonly runtimePolicy?: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
}): ProviderAdapter.ProviderAdapterV2TurnInput {
  return {
    appThread: makeClaudeTestAppThread(input),
    threadId: input.threadId,
    runId: RunId.make(`run-${input.attemptId}`),
    runOrdinal: 1,
    providerTurnOrdinal: input.providerTurnOrdinal ?? 1,
    ...(input.nativeThreadHasTurns === undefined
      ? {}
      : { nativeThreadHasTurns: input.nativeThreadHasTurns }),
    attemptId: input.attemptId,
    rootNodeId: NodeId.make(`node-${input.attemptId}`),
    providerThread: input.providerThread,
    message: {
      createdBy: input.messageCreatedBy ?? "user",
      creationSource: input.messageCreationSource ?? "web",
      messageId: MessageId.make(`message-${input.attemptId}`),
      text: input.text,
      attachments: input.attachments,
    },
    modelSelection: input.modelSelection ?? CLAUDE_TEST_MODEL_SELECTION,
    runtimePolicy: input.runtimePolicy ?? CLAUDE_TEST_RUNTIME_POLICY,
  };
}

describe("ClaudeAdapterV2 file restore", () => {
  const makeFileRestoreAdapter = Effect.fn("makeFileRestoreAdapter")(function* (sdk: {
    readonly opened: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOptions>;
    readonly rewinds: Array<{ readonly userMessageId: string; readonly dryRun: boolean }>;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-claude-rewind-files-",
    });
    return yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CLAUDE_SETTINGS,
      environment: {},
      attachmentsDir,
      fileSystem,
      path: yield* Path.Path,
      random: yield* SecureRandom.SecureRandom,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      queryRunner: {
        allocateSessionId: Effect.succeed("native-thread-claude-rewind-files"),
        open: (input) =>
          Effect.sync(() => {
            sdk.opened.push(input.options);
            return {
              messages: Stream.never,
              offer: () => Effect.void,
              setModel: () => Effect.void,
              setPermissionMode: () => Effect.void,
              applyFlagSettings: () => Effect.void,
              stopTask: () => Effect.void,
              backgroundTasks: () => Effect.succeed(false),
              mcpServerStatus: Effect.succeed([]),
              readMcpResource: () => Effect.die("unexpected MCP resource read"),
              callMcpTool: () => Effect.die("unexpected MCP tool call"),
              listPermissionRules: Effect.die("unexpected permission rules read"),
              interrupt: Effect.void,
              close: Effect.void,
              rewindFiles: (userMessageId, options) =>
                Effect.sync(() => {
                  sdk.rewinds.push({ userMessageId, dryRun: options.dryRun });
                  return options.dryRun
                    ? {
                        canRewind: true,
                        filesChanged: ["/workspace/notes.md"],
                        insertions: 1,
                        deletions: 2,
                      }
                    : { canRewind: true, skippedLinks: 1 };
                }),
            };
          }),
        forkSession: () => Effect.die("unused"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        assertComplete: Effect.void,
      },
    });
  });

  it.effect("previews and restores files of an idle thread through its resumed session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sdk = { opened: [], rewinds: [] } as {
          opened: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOptions>;
          rewinds: Array<{ userMessageId: string; dryRun: boolean }>;
        };
        const adapter = yield* makeFileRestoreAdapter(sdk);
        const threadId = ThreadId.make("thread-claude-rewind-files");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-rewind-files"),
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        assert.isFunction(runtime.rewindFiles);
        const restore = (dryRun: boolean) =>
          runtime.rewindFiles!({
            providerThread,
            nativeUserMessageId: "user-uuid-2",
            dryRun,
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });

        const preview = yield* restore(true);
        const restored = yield* restore(false);

        assert.deepEqual(preview, {
          canRewind: true,
          filesChanged: ["/workspace/notes.md"],
          insertions: 1,
          deletions: 2,
          skippedLinks: 0,
        });
        assert.deepEqual(restored, {
          canRewind: true,
          filesChanged: [],
          insertions: 0,
          deletions: 0,
          skippedLinks: 1,
        });
        assert.deepEqual(sdk.rewinds, [
          { userMessageId: "user-uuid-2", dryRun: true },
          { userMessageId: "user-uuid-2", dryRun: false },
        ]);
        // The session's file history lives in its transcript: each restore
        // resumes it with checkpointing on.
        assert.isTrue(
          sdk.opened.every(
            (options) =>
              options.resume === "native-thread-claude-rewind-files" &&
              options.enableFileCheckpointing === true,
          ),
        );
      }).pipe(Effect.provide(ADAPTER_TEST_LAYER)),
    ),
  );

  it.effect(
    "opens a restore-only Claude process without the user's settings and hooks, but a turn with them",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sdk = { opened: [], rewinds: [] } as {
            opened: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOptions>;
            rewinds: Array<{ userMessageId: string; dryRun: boolean }>;
          };
          const adapter = yield* makeFileRestoreAdapter(sdk);
          const threadId = ThreadId.make("thread-claude-rewind-files-settings");
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make(
              "provider-session-claude-rewind-files-settings",
            ),
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          const restore = (dryRun: boolean) =>
            runtime.rewindFiles!({
              providerThread,
              nativeUserMessageId: "user-uuid-3",
              dryRun,
              modelSelection: CLAUDE_TEST_MODEL_SELECTION,
              runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
            });
          yield* restore(true);
          yield* restore(false);
          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-claude-rewind-files-settings"),
              text: "Edit the notes.",
              attachments: [],
              runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
            }),
          );

          assert.equal(sdk.opened.length, 3);
          const [previewOptions, restoreOptions, turnOptions] = sdk.opened;
          // A project SessionStart hook held a restore preview for 7.5 s:
          // a process that only restores files loads no settings files.
          assert.deepEqual(previewOptions?.settingSources, []);
          assert.deepEqual(restoreOptions?.settingSources, []);
          assert.isUndefined(turnOptions?.settingSources);
        }).pipe(Effect.provide(ADAPTER_TEST_LAYER)),
      ),
  );

  it.effect(
    "previews and restores files through a running turn's Claude process without starting another",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sdk = { opened: [], rewinds: [] } as {
            opened: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOptions>;
            rewinds: Array<{ userMessageId: string; dryRun: boolean }>;
          };
          const adapter = yield* makeFileRestoreAdapter(sdk);
          const threadId = ThreadId.make("thread-claude-rewind-files-live");
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("provider-session-claude-rewind-files-live"),
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-claude-rewind-files-live"),
              text: "Edit the notes.",
              attachments: [],
              runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
            }),
          );

          const restore = (dryRun: boolean) =>
            runtime.rewindFiles!({
              providerThread,
              nativeUserMessageId: "user-uuid-1",
              dryRun,
              modelSelection: CLAUDE_TEST_MODEL_SELECTION,
              runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
            });
          const preview = yield* restore(true);
          const restored = yield* restore(false);

          assert.deepEqual(preview.filesChanged, ["/workspace/notes.md"]);
          assert.isTrue(restored.canRewind);
          assert.equal(sdk.opened.length, 1);
          assert.deepEqual(sdk.rewinds, [
            { userMessageId: "user-uuid-1", dryRun: true },
            { userMessageId: "user-uuid-1", dryRun: false },
          ]);
        }).pipe(Effect.provide(ADAPTER_TEST_LAYER)),
      ),
  );
});

describe("ClaudeAdapterV2 rewind cursor", () => {
  const providerThreadId = ProviderThreadId.make("provider-thread-claude-rewind-cursor");
  const turn = (ordinal: number, nativeId: string) =>
    ({
      id: ProviderTurnId.make(`provider-turn-${ordinal}`),
      providerThreadId,
      runAttemptId: RunAttemptId.make(`attempt-${ordinal}`),
      nativeTurnRef: { driver: "claudeAgent", nativeId, strength: "weak" },
      ordinal,
      status: "completed",
    }) as unknown as OrchestrationV2ProviderTurn;
  const resolve = (target: OrchestrationV2ProviderTurn, turns: OrchestrationV2ProviderTurn[]) =>
    ClaudeAdapterV2.resolveClaudeRollbackResumeSessionAt({
      providerThread: { id: providerThreadId } as never,
      target: { type: "provider_turn", appRunOrdinal: target.ordinal, providerTurn: target },
      providerThreadTurns: turns,
    });

  it.effect("resumes at the turn's last assistant uuid", () =>
    Effect.gen(function* () {
      const target = turn(1, "assistant-uuid-1");
      assert.equal(
        yield* resolve(target, [target, turn(2, "assistant-uuid-2")]),
        "assistant-uuid-1",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("resumes after the prompt of a turn that ended before Claude replied", () =>
    Effect.gen(function* () {
      const target = {
        ...turn(1, "turn:attempt-1"),
        nativeUserMessageId: "prompt-uuid-1",
      } as OrchestrationV2ProviderTurn;
      assert.equal(yield* resolve(target, [target, turn(2, "assistant-uuid-2")]), "prompt-uuid-1");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("resumes after the prompt of a stopped turn recorded before prompt ids were kept", () =>
    Effect.gen(function* () {
      // Builds before random prompt ids sent a uuid derived from the attempt
      // and recorded none, so the derivation is the only cursor such a turn has.
      const target = turn(1, "turn:attempt-1");
      assert.equal(
        yield* resolve(target, [target, turn(2, "assistant-uuid-2")]),
        "01dd98ff-23e3-41d9-8bb1-9896b5445060",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("cannot resume after a turn that recorded neither a reply nor its prompt", () =>
    Effect.gen(function* () {
      const target = {
        ...turn(1, "turn:attempt-1"),
        runAttemptId: null,
      } as OrchestrationV2ProviderTurn;
      const exit = yield* Effect.exit(resolve(target, [target, turn(2, "assistant-uuid-2")]));
      assert.isTrue(Exit.isFailure(exit));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("starts over at the thread start, or resumes where an import's start is", () =>
    Effect.gen(function* () {
      const resolveStart = (nativeResumeAt?: string) =>
        ClaudeAdapterV2.resolveClaudeRollbackResumeSessionAt({
          providerThread: { id: providerThreadId } as never,
          target: {
            type: "thread_start",
            appRunOrdinal: 0,
            ...(nativeResumeAt === undefined ? {} : { nativeResumeAt }),
          },
          providerThreadTurns: [],
        });
      assert.equal(yield* resolveStart(), null);
      assert.equal(yield* resolveStart("reply-2"), "reply-2");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
