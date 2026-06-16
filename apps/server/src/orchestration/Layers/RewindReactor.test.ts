// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSession,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { expect, it } from "@effect/vitest";

import { CheckpointStoreLive } from "../../checkpointing/Layers/CheckpointStore.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { RewindReactorLive } from "./RewindReactor.ts";
import { RuntimeReceiptBusLive } from "./RuntimeReceiptBus.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RewindReactor } from "../Services/RewindReactor.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "../../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderService, type ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { ServerConfig } from "../../config.ts";
import { WorkspaceEntriesLive } from "../../workspace/Layers/WorkspaceEntries.ts";
import { WorkspacePathsLive } from "../../workspace/Layers/WorkspacePaths.ts";

const threadId = ThreadId.make("thread-1");

class WaitForConditionError extends Data.TaggedError("WaitForConditionError")<{
  readonly message: string;
}> {}

// Effect-based poll: retries the predicate on a fixed cadence until it returns
// true or the timeout elapses. Replaces the old Promise/setTimeout loop so the
// whole test runs under the @effect/vitest runner (live clock — see it.layer's
// excludeTestServices below).
const waitFor = <E, R>(
  predicate: Effect.Effect<boolean, E, R>,
  timeout: Duration.Input = "15 seconds",
): Effect.Effect<void, WaitForConditionError | E, R> =>
  predicate.pipe(
    Effect.filterOrFail(
      (done) => done,
      () => new WaitForConditionError({ message: "Condition not met" }),
    ),
    Effect.retry(Schedule.spaced("10 millis")),
    Effect.timeoutOption(timeout),
    Effect.flatMap((result) =>
      Option.match(result, {
        onNone: () =>
          Effect.fail(new WaitForConditionError({ message: "Timed out waiting for reactor state." })),
        onSome: () => Effect.void,
      }),
    ),
  );

function unsupported<A>() {
  return Effect.die(new Error("Unsupported provider call in test")) as Effect.Effect<A, never>;
}

// Records `stopSession` calls so tests can assert the rewind handler issues a
// full provider-session stop (the cold-start trigger for the marker — ADR-0002).
// `hasLiveSession` lets a test simulate the no-live-session branch where the
// handler must skip the stop (clean no-op) but still emit the abandoned event.
interface StopRecorder {
  readonly calls: Array<{ readonly threadId: ThreadId }>;
  hasLiveSession: boolean;
}

function makeProviderServiceMock(
  cwd: string,
  stopRecorder: StopRecorder,
): ProviderServiceShape {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: (input) =>
      Effect.sync(() => {
        stopRecorder.calls.push({ threadId: (input as { threadId: ThreadId }).threadId });
      }) as ReturnType<ProviderServiceShape["stopSession"]>,
    listSessions: () =>
      Effect.succeed(
        stopRecorder.hasLiveSession
          ? ([
              {
                provider: ProviderDriverKind.make("codex"),
                status: "ready",
                runtimeMode: "full-access",
                threadId,
                cwd,
                createdAt: now,
                updatedAt: now,
              },
            ] satisfies ReadonlyArray<ProviderSession>)
          : ([] satisfies ReadonlyArray<ProviderSession>),
      ),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    getInstanceInfo: (instanceId) =>
      Effect.succeed({
        instanceId,
        driverKind: ProviderDriverKind.make("codex"),
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: ProviderDriverKind.make("codex"),
          continuationKey: `codex:instance:${instanceId}`,
        },
      }),
    rollbackConversation: () => unsupported(),
    get streamEvents() {
      return Stream.empty;
    },
  };
}

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
}

function createGitRepository() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "t3-rewind-reactor-"));
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(cwd, "README.md"), "v1\n", "utf8");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
  return cwd;
}

// Builds a fresh, fully-isolated harness for one test: its own git repo +
// in-memory SQLite + reactor. Built into the ambient test scope (Layer.build),
// so all resources tear down when the test's scope closes. The reactor is
// started via the ambient scope too (its daemon is interrupted on close).
const createHarness = () =>
  Effect.gen(function* () {
    const cwd = createGitRepository();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        fs.rmSync(cwd, { recursive: true, force: true });
      }),
    );

    const stopRecorder: StopRecorder = { calls: [], hasLiveSession: true };

    // One shared in-memory DB + one shared projection snapshot query so the
    // engine's projected rows, the reactor's reads, the test's reads, and the
    // session directory all see the same data. Everything is layered off a
    // single `dataLayer` so Effect memoizes the SqlitePersistenceMemory instance
    // across all consumers in this runtime.
    const dataLayer = Layer.mergeAll(
      OrchestrationProjectionSnapshotQueryLive,
      OrchestrationProjectionPipelineLive,
      ProjectionThreadMessageRepositoryLive,
      ProjectionTurnRepositoryLive,
      ProviderSessionDirectoryLive,
    ).pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
      Layer.provideMerge(ProviderSessionRuntimeRepositoryLive),
      Layer.provideMerge(RepositoryIdentityResolverLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    const layer = RewindReactorLive.pipe(
      Layer.provideMerge(OrchestrationEngineLive),
      Layer.provideMerge(dataLayer),
      Layer.provideMerge(RuntimeReceiptBusLive),
      Layer.provideMerge(
        Layer.succeed(ProviderService, makeProviderServiceMock(cwd, stopRecorder)),
      ),
      Layer.provideMerge(CheckpointStoreLive.pipe(Layer.provide(VcsDriverRegistry.layer))),
      Layer.provideMerge(
        WorkspaceEntriesLive.pipe(
          Layer.provide(WorkspacePathsLive),
          Layer.provideMerge(VcsDriverRegistry.layer),
        ),
      ),
      Layer.provideMerge(WorkspacePathsLive),
      Layer.provideMerge(VcsProcess.layer),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-rewind-reactor-" })),
      Layer.provideMerge(NodeServices.layer),
    );

    const context = yield* Layer.build(layer);
    const engine = Context.get(context, OrchestrationEngineService);
    const snapshotQuery = Context.get(context, ProjectionSnapshotQuery);
    const reactor = Context.get(context, RewindReactor);
    const directory = Context.get(context, ProviderSessionDirectory);
    const checkpointStore = Context.get(context, CheckpointStore);
    yield* reactor.start();

    const now = "2026-01-01T00:00:00.000Z";
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-project"),
      projectId: ProjectId.make("project-1"),
      title: "Project",
      workspaceRoot: cwd,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      createdAt: now,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-thread"),
      threadId,
      projectId: ProjectId.make("project-1"),
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: cwd,
      createdAt: now,
    });

    return { engine, snapshotQuery, reactor, directory, checkpointStore, cwd, stopRecorder };
  });

// Seed a small conversation with an anchor uuid on the first assistant reply.
const seedConversation = (engine: OrchestrationEngineShape) =>
  Effect.gen(function* () {
    const send = (suffix: string, createdAt: string, providerMessageUuid?: string) =>
      engine.dispatch({
        type: "thread.message.user.record",
        commandId: CommandId.make(`cmd-msg-${suffix}`),
        threadId,
        messageId: MessageId.make(`message-${suffix}`),
        text: suffix,
        ...(providerMessageUuid ? { providerMessageUuid } : {}),
        createdAt,
      } as never);

    // user.record only records user rows; for the assistant anchor we use the
    // assistant.complete command which carries the turn-final uuid.
    yield* send("a-user", "2026-01-01T00:01:00.000Z");
    yield* engine.dispatch({
      type: "thread.message.assistant.complete",
      commandId: CommandId.make("cmd-msg-a-assistant"),
      threadId,
      messageId: MessageId.make("message-a-assistant"),
      providerMessageUuid: "claude-uuid-a-assistant",
      createdAt: "2026-01-01T00:01:01.000Z",
    } as never);
    yield* send("b-user", "2026-01-01T00:01:02.000Z");
  });

it.layer(NodeServices.layer, { excludeTestServices: true })("RewindReactor", (it) => {
  it.effect("resolves the pre-prompt anchor uuid and writes the cursor marker", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();

      // Seed a provider-session binding carrying a stale forward resumeSessionAt so
      // we can prove the rewind overrides it (not merely preserves it).
      yield* harness.directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        resumeCursor: {
          resume: "session-abc",
          resumeSessionAt: "claude-uuid-FORWARD",
          turnCount: 5,
          custom: "keep-me",
        },
      });

      yield* seedConversation(harness.engine);

      // Sanity: the forward prompt is in the active timeline BEFORE the rewind, so
      // the post-rewind "hidden" assertion below is non-vacuous.
      const before = yield* harness.snapshotQuery.getThreadDetailById(threadId);
      expect(
        Option.isSome(before) ? before.value.messages.map((message) => message.id) : [],
      ).toContain(MessageId.make("message-b-user"));

      yield* harness.engine.dispatch({
        type: "thread.conversation.rewind",
        commandId: CommandId.make("cmd-rewind"),
        threadId,
        messageId: MessageId.make("message-b-user"),
        createdAt: "2026-01-01T00:02:00.000Z",
      });

      // Wait until the cursor blob carries the marker.
      let cursor: Record<string, unknown> = {};
      yield* waitFor(
        Effect.gen(function* () {
          const binding = yield* harness.directory.getBinding(threadId);
          if (Option.isNone(binding)) {
            return false;
          }
          const raw = binding.value.resumeCursor;
          cursor = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
          return cursor.rewindPending === true;
        }),
      );

      // Anchor = the assistant uuid immediately before the b-user prompt.
      expect(cursor.resumeSessionAt).toBe("claude-uuid-a-assistant");
      expect(cursor.rewindPending).toBe(true);
      // The stale forward value was overridden, unknown fields preserved.
      expect(cursor.resume).toBe("session-abc");
      expect(cursor.custom).toBe("keep-me");

      // The handler MUST stop the live provider session so the next prompt
      // cold-starts and the adapter consumes the marker (ADR-0002 integration fix).
      // Stop is awaited before the rewind completes, so by now it has fired exactly
      // once for this thread.
      expect(harness.stopRecorder.calls).toEqual([{ threadId }]);

      // The stop's directory upsert omits `resumeCursor`, so the marker blob we set
      // above survives the stop (it does not clobber the anchor).
      expect(cursor.resumeSessionAt).toBe("claude-uuid-a-assistant");
      expect(cursor.rewindPending).toBe(true);

      // The abandoned event still fired: the rewound forward prompt (b-user) drops
      // out of the active timeline (marked abandoned, not deleted).
      yield* waitFor(
        Effect.gen(function* () {
          const detail = yield* harness.snapshotQuery.getThreadDetailById(threadId);
          if (Option.isNone(detail)) {
            return false;
          }
          return !detail.value.messages.some(
            (message) => message.id === MessageId.make("message-b-user"),
          );
        }),
      );
      const detail = yield* harness.snapshotQuery.getThreadDetailById(threadId);
      const activeMessageIds = Option.isSome(detail)
        ? detail.value.messages.map((message) => message.id)
        : [];
      expect(activeMessageIds).not.toContain(MessageId.make("message-b-user"));
    }),
  );

  it.effect("skips the stop (clean no-op) when no live provider session is bound", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      yield* seedConversation(harness.engine);

      // No live provider session for this thread: the handler must SKIP the stop
      // (a stop with `allowRecovery: false` would error and abort the handler
      // before the abandoned event), yet still mark the forward turns abandoned.
      harness.stopRecorder.hasLiveSession = false;
      harness.stopRecorder.calls.length = 0;

      // Sanity: the forward prompt is present before the rewind.
      const before = yield* harness.snapshotQuery.getThreadDetailById(threadId);
      expect(
        Option.isSome(before) ? before.value.messages.map((message) => message.id) : [],
      ).toContain(MessageId.make("message-b-user"));

      yield* harness.engine.dispatch({
        type: "thread.conversation.rewind",
        commandId: CommandId.make("cmd-rewind-noop"),
        threadId,
        messageId: MessageId.make("message-b-user"),
        createdAt: "2026-01-01T00:02:00.000Z",
      });

      yield* waitFor(
        Effect.gen(function* () {
          const detail = yield* harness.snapshotQuery.getThreadDetailById(threadId);
          if (Option.isNone(detail)) {
            return false;
          }
          return !detail.value.messages.some(
            (message) => message.id === MessageId.make("message-b-user"),
          );
        }),
      );
      const detail = yield* harness.snapshotQuery.getThreadDetailById(threadId);
      const activeMessageIds = Option.isSome(detail)
        ? detail.value.messages.map((message) => message.id)
        : [];
      expect(activeMessageIds).not.toContain(MessageId.make("message-b-user"));

      // No live session → the stop was skipped, not attempted.
      expect(harness.stopRecorder.calls).toEqual([]);
    }),
  );

  it.effect("cancel un-abandons the hidden rows, clears the cursor, restores the timeline", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();

      // Seed a binding with the rewind marker already present (as a rewind would
      // have left it) plus the durable resume id + an unknown field to preserve.
      yield* harness.directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        resumeCursor: {
          resume: "session-abc",
          resumeSessionAt: "claude-uuid-a-assistant",
          rewindPending: true,
          custom: "keep-me",
        },
      });

      yield* seedConversation(harness.engine);

      // Rewind to the b-user prompt (hides b-user forward).
      yield* harness.engine.dispatch({
        type: "thread.conversation.rewind",
        commandId: CommandId.make("cmd-rewind"),
        threadId,
        messageId: MessageId.make("message-b-user"),
        createdAt: "2026-01-01T00:02:00.000Z",
      });

      // Wait until b-user is hidden (the rewind landed).
      yield* waitFor(
        Effect.gen(function* () {
          const detail = yield* harness.snapshotQuery.getThreadDetailById(threadId);
          return (
            Option.isSome(detail) &&
            !detail.value.messages.some((message) => message.id === MessageId.make("message-b-user"))
          );
        }),
      );

      // Cancel the un-sent rewind.
      yield* harness.engine.dispatch({
        type: "thread.conversation.rewind.cancel",
        commandId: CommandId.make("cmd-rewind-cancel"),
        threadId,
        messageId: MessageId.make("message-b-user"),
        createdAt: "2026-01-01T00:02:30.000Z",
      });

      // The hidden prompt comes back into the active timeline.
      yield* waitFor(
        Effect.gen(function* () {
          const detail = yield* harness.snapshotQuery.getThreadDetailById(threadId);
          return (
            Option.isSome(detail) &&
            detail.value.messages.some((message) => message.id === MessageId.make("message-b-user"))
          );
        }),
      );
      const detail = yield* harness.snapshotQuery.getThreadDetailById(threadId);
      const activeMessageIds = Option.isSome(detail)
        ? detail.value.messages.map((message) => message.id)
        : [];
      expect(activeMessageIds).toContain(MessageId.make("message-b-user"));

      // The pending cursor was cleared: rewindPending false, the anchor stripped,
      // durable + unknown fields preserved.
      let cursor: Record<string, unknown> = {};
      yield* waitFor(
        Effect.gen(function* () {
          const binding = yield* harness.directory.getBinding(threadId);
          if (Option.isNone(binding)) {
            return false;
          }
          const raw = binding.value.resumeCursor;
          cursor = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
          return cursor.rewindPending === false;
        }),
      );
      expect(cursor.rewindPending).toBe(false);
      expect(cursor.resumeSessionAt).toBeUndefined();
      expect(cursor.resume).toBe("session-abc");
      expect(cursor.custom).toBe("keep-me");
    }),
  );

  it.effect(
    "file-restore reverts only the agent's files and leaves the user's tracked changes intact",
    () =>
      Effect.gen(function* () {
        const harness = yield* createHarness();
        yield* seedConversation(harness.engine);

        // The repo starts with README.md="v1\n" (from createGitRepository).
        // Also commit a second tracked file that belongs to the USER (not the agent).
        fs.writeFileSync(path.join(harness.cwd, "notes.txt"), "user-v1\n", "utf8");
        runGit(harness.cwd, ["add", "notes.txt"]);
        runGit(harness.cwd, ["commit", "-m", "Add notes.txt"]);

        // Turn 0: capture the initial state.
        yield* harness.checkpointStore.captureCheckpoint({
          cwd: harness.cwd,
          checkpointRef: checkpointRefForThreadTurn(threadId, 0),
        });

        // Turn 1: agent writes README.md="v2", user writes notes.txt="user-v2".
        // Capture checkpoint — both files snapshotted at these values.
        fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
        fs.writeFileSync(path.join(harness.cwd, "notes.txt"), "user-v2\n", "utf8");
        yield* harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make("cmd-turn-diff-1"),
          threadId,
          turnId: TurnId.make("turn-1"),
          completedAt: "2026-01-01T00:01:30.000Z",
          checkpointRef: checkpointRefForThreadTurn(threadId, 1),
          status: "ready",
          files: [],
          checkpointTurnCount: NonNegativeInt.make(1),
          createdAt: "2026-01-01T00:01:30.000Z",
        } as never);
        yield* harness.checkpointStore.captureCheckpoint({
          cwd: harness.cwd,
          checkpointRef: checkpointRefForThreadTurn(threadId, 1),
        });

        // Turn 2: agent writes README.md="v3" (agent's edit).
        // User also updates notes.txt="user-v3" (user's subsequent edit, NOT in agent set).
        fs.writeFileSync(path.join(harness.cwd, "README.md"), "v3\n", "utf8");
        fs.writeFileSync(path.join(harness.cwd, "notes.txt"), "user-v3\n", "utf8");

        // Register the turn-2 mapping in the projection.
        yield* harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make("cmd-turn-diff-2"),
          threadId,
          turnId: TurnId.make("turn-2"),
          completedAt: "2026-01-01T00:02:00.000Z",
          checkpointRef: checkpointRefForThreadTurn(threadId, 2),
          status: "ready",
          files: [],
          checkpointTurnCount: NonNegativeInt.make(2),
          createdAt: "2026-01-01T00:02:00.000Z",
        } as never);

        // Seed a file_change activity attributing README.md to turn-2. Absolute
        // path exercises the abs→relative normalization in agentEditSetForUndoneSpan.
        // notes.txt is intentionally NOT in the agent edit set.
        yield* harness.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make("cmd-activity-1"),
          threadId,
          activity: {
            id: EventId.make("evt-activity-1"),
            tone: "tool",
            kind: "tool.completed",
            summary: "Edit",
            payload: {
              itemType: "file_change",
              data: { input: { file_path: path.join(harness.cwd, "README.md") } },
            },
            turnId: TurnId.make("turn-2"),
            createdAt: "2026-01-01T00:02:01.000Z",
          },
          createdAt: "2026-01-01T00:02:01.000Z",
        } as never);

        // Guard assertion: confirm the activity was projected before we trigger restore.
        const threadDetail = yield* harness.snapshotQuery.getThreadDetailById(threadId);
        const detail = Option.getOrUndefined(threadDetail);
        expect(detail).toBeDefined();
        const fileChangeActivity = detail!.activities.find(
          (a) =>
            a.turnId === "turn-2" &&
            typeof a.payload === "object" &&
            a.payload !== null &&
            (a.payload as Record<string, unknown>).itemType === "file_change",
        );
        expect(
          fileChangeActivity,
          "Guard: file_change activity for turn-2 must be projected before restore",
        ).toBeDefined();

        // Count messages before restore — they must survive untouched.
        const messagesBefore = yield* harness.snapshotQuery.getThreadDetailById(threadId);
        const countBefore = Option.isSome(messagesBefore) ? messagesBefore.value.messages.length : 0;
        expect(countBefore).toBeGreaterThan(0);

        // Restore files to turn 1. The scoped restore should revert only README.md
        // (the agent's file, per the file_change activity) and leave notes.txt at
        // "user-v3" (the user's own edit after turn-1, not in the agent edit set).
        // The OLD whole-tree `git restore -- .` would have reverted notes.txt back
        // to "user-v2" (the checkpoint value), FAILING the assertion below.
        yield* harness.engine.dispatch({
          type: "thread.files.restore",
          commandId: CommandId.make("cmd-files-restore"),
          threadId,
          turnCount: NonNegativeInt.make(1),
          createdAt: "2026-01-01T00:03:00.000Z",
        });

        yield* waitFor(
          // During the working-tree restore README.md is briefly absent; a transient
          // ENOENT must read as "not ready yet" (retryable false), not a defect.
          Effect.sync(() => {
            try {
              return fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8") === "v2\n";
            } catch (error) {
              if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
              throw error;
            }
          }),
        );

        // The agent's file was reverted (scoped restore worked).
        expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
        // The user's tracked file was NOT reverted — their "user-v3" edit survived.
        // Under old whole-tree restore this would be "user-v2" (FAIL). Under scoped
        // restore this is "user-v3" (PASS) because notes.txt is not in the agent
        // edit set.
        expect(fs.readFileSync(path.join(harness.cwd, "notes.txt"), "utf8")).toBe("user-v3\n");
        // The conversation is untouched.
        const messagesAfter = yield* harness.snapshotQuery.getThreadDetailById(threadId);
        const countAfter = Option.isSome(messagesAfter) ? messagesAfter.value.messages.length : 0;
        expect(countAfter).toBe(countBefore);
      }),
  );
});
