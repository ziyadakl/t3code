// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
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
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it } from "vite-plus/test";

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

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for reactor state.");
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
    return poll();
  };
  return poll();
}

describe("RewindReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | RewindReactor
    | ProjectionSnapshotQuery
    | ProviderSessionDirectory
    | CheckpointStore,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  async function createHarness() {
    const cwd = createGitRepository();
    tempDirs.push(cwd);

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

    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await runtime.runPromise(Effect.service(RewindReactor));
    const directory = await runtime.runPromise(Effect.service(ProviderSessionDirectory));
    const checkpointStore = await runtime.runPromise(Effect.service(CheckpointStore));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));

    const now = "2026-01-01T00:00:00.000Z";
    await Effect.runPromise(
      engine.dispatch({
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
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
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
      }),
    );

    return { engine, snapshotQuery, reactor, directory, checkpointStore, cwd, stopRecorder };
  }

  // Seed a small conversation with an anchor uuid on the first assistant reply.
  async function seedConversation(engine: OrchestrationEngineShape) {
    const send = (
      suffix: string,
      role: "user" | "assistant",
      createdAt: string,
      providerMessageUuid?: string,
    ) =>
      Effect.runPromise(
        engine.dispatch({
          type: "thread.message.user.record",
          commandId: CommandId.make(`cmd-msg-${suffix}`),
          threadId,
          messageId: MessageId.make(`message-${suffix}`),
          text: suffix,
          ...(providerMessageUuid ? { providerMessageUuid } : {}),
          createdAt,
        } as never),
      ).then(() => undefined);

    // user.record only records user rows; for the assistant anchor we use the
    // assistant.complete command which carries the turn-final uuid.
    await send("a-user", "user", "2026-01-01T00:01:00.000Z");
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-msg-a-assistant"),
        threadId,
        messageId: MessageId.make("message-a-assistant"),
        providerMessageUuid: "claude-uuid-a-assistant",
        createdAt: "2026-01-01T00:01:01.000Z",
      } as never),
    );
    await send("b-user", "user", "2026-01-01T00:01:02.000Z");
  }

  it("resolves the pre-prompt anchor uuid and writes the cursor marker", async () => {
    const harness = await createHarness();

    // Seed a provider-session binding carrying a stale forward resumeSessionAt so
    // we can prove the rewind overrides it (not merely preserves it).
    await Effect.runPromise(
      harness.directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        resumeCursor: {
          resume: "session-abc",
          resumeSessionAt: "claude-uuid-FORWARD",
          turnCount: 5,
          custom: "keep-me",
        },
      }),
    );

    await seedConversation(harness.engine);

    // Sanity: the forward prompt is in the active timeline BEFORE the rewind, so
    // the post-rewind "hidden" assertion below is non-vacuous.
    const before = await Effect.runPromise(harness.snapshotQuery.getThreadDetailById(threadId));
    expect(
      Option.isSome(before)
        ? before.value.messages.map((message) => message.id)
        : [],
    ).toContain(MessageId.make("message-b-user"));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.conversation.rewind",
        commandId: CommandId.make("cmd-rewind"),
        threadId,
        messageId: MessageId.make("message-b-user"),
        createdAt: "2026-01-01T00:02:00.000Z",
      }),
    );

    // Wait until the cursor blob carries the marker.
    let cursor: Record<string, unknown> = {};
    await waitFor(async () => {
      const binding = await Effect.runPromise(harness.directory.getBinding(threadId));
      if (Option.isNone(binding)) {
        return false;
      }
      const raw = binding.value.resumeCursor;
      cursor = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      return cursor.rewindPending === true;
    });

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
    await waitFor(async () => {
      const detail = await Effect.runPromise(harness.snapshotQuery.getThreadDetailById(threadId));
      if (Option.isNone(detail)) {
        return false;
      }
      return !detail.value.messages.some(
        (message) => message.id === MessageId.make("message-b-user"),
      );
    });
    const detail = await Effect.runPromise(harness.snapshotQuery.getThreadDetailById(threadId));
    const activeMessageIds = Option.isSome(detail)
      ? detail.value.messages.map((message) => message.id)
      : [];
    expect(activeMessageIds).not.toContain(MessageId.make("message-b-user"));
  });

  it("skips the stop (clean no-op) when no live provider session is bound", async () => {
    const harness = await createHarness();
    await seedConversation(harness.engine);

    // No live provider session for this thread: the handler must SKIP the stop
    // (a stop with `allowRecovery: false` would error and abort the handler
    // before the abandoned event), yet still mark the forward turns abandoned.
    harness.stopRecorder.hasLiveSession = false;
    harness.stopRecorder.calls.length = 0;

    // Sanity: the forward prompt is present before the rewind.
    const before = await Effect.runPromise(harness.snapshotQuery.getThreadDetailById(threadId));
    expect(
      Option.isSome(before)
        ? before.value.messages.map((message) => message.id)
        : [],
    ).toContain(MessageId.make("message-b-user"));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.conversation.rewind",
        commandId: CommandId.make("cmd-rewind-noop"),
        threadId,
        messageId: MessageId.make("message-b-user"),
        createdAt: "2026-01-01T00:02:00.000Z",
      }),
    );

    await waitFor(async () => {
      const detail = await Effect.runPromise(harness.snapshotQuery.getThreadDetailById(threadId));
      if (Option.isNone(detail)) {
        return false;
      }
      return !detail.value.messages.some(
        (message) => message.id === MessageId.make("message-b-user"),
      );
    });
    const detail = await Effect.runPromise(harness.snapshotQuery.getThreadDetailById(threadId));
    const activeMessageIds = Option.isSome(detail)
      ? detail.value.messages.map((message) => message.id)
      : [];
    expect(activeMessageIds).not.toContain(MessageId.make("message-b-user"));

    // No live session → the stop was skipped, not attempted.
    expect(harness.stopRecorder.calls).toEqual([]);
  });

  it("cancel un-abandons the hidden rows, clears the cursor, restores the timeline", async () => {
    const harness = await createHarness();

    // Seed a binding with the rewind marker already present (as a rewind would
    // have left it) plus the durable resume id + an unknown field to preserve.
    await Effect.runPromise(
      harness.directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        resumeCursor: {
          resume: "session-abc",
          resumeSessionAt: "claude-uuid-a-assistant",
          rewindPending: true,
          custom: "keep-me",
        },
      }),
    );

    await seedConversation(harness.engine);

    // Rewind to the b-user prompt (hides b-user forward).
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.conversation.rewind",
        commandId: CommandId.make("cmd-rewind"),
        threadId,
        messageId: MessageId.make("message-b-user"),
        createdAt: "2026-01-01T00:02:00.000Z",
      }),
    );

    // Wait until b-user is hidden (the rewind landed).
    await waitFor(async () => {
      const detail = await Effect.runPromise(harness.snapshotQuery.getThreadDetailById(threadId));
      return (
        Option.isSome(detail) &&
        !detail.value.messages.some((message) => message.id === MessageId.make("message-b-user"))
      );
    });

    // Cancel the un-sent rewind.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.conversation.rewind.cancel",
        commandId: CommandId.make("cmd-rewind-cancel"),
        threadId,
        messageId: MessageId.make("message-b-user"),
        createdAt: "2026-01-01T00:02:30.000Z",
      }),
    );

    // The hidden prompt comes back into the active timeline.
    await waitFor(async () => {
      const detail = await Effect.runPromise(harness.snapshotQuery.getThreadDetailById(threadId));
      return (
        Option.isSome(detail) &&
        detail.value.messages.some((message) => message.id === MessageId.make("message-b-user"))
      );
    });
    const detail = await Effect.runPromise(harness.snapshotQuery.getThreadDetailById(threadId));
    const activeMessageIds = Option.isSome(detail)
      ? detail.value.messages.map((message) => message.id)
      : [];
    expect(activeMessageIds).toContain(MessageId.make("message-b-user"));

    // The pending cursor was cleared: rewindPending false, the anchor stripped,
    // durable + unknown fields preserved.
    let cursor: Record<string, unknown> = {};
    await waitFor(async () => {
      const binding = await Effect.runPromise(harness.directory.getBinding(threadId));
      if (Option.isNone(binding)) {
        return false;
      }
      const raw = binding.value.resumeCursor;
      cursor = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      return cursor.rewindPending === false;
    });
    expect(cursor.rewindPending).toBe(false);
    expect(cursor.resumeSessionAt).toBeUndefined();
    expect(cursor.resume).toBe("session-abc");
    expect(cursor.custom).toBe("keep-me");
  });

  it("file-restore restores the tree without touching message rows", async () => {
    const harness = await createHarness();
    await seedConversation(harness.engine);

    // Capture checkpoints for turn 0 (v1) and turn 1 (v2).
    await Effect.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(threadId, 0),
      }),
    );
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");

    // Register the turn-1 checkpoint in the projection via a turn-diff-complete so
    // the reactor can resolve its ref.
    await Effect.runPromise(
      harness.engine.dispatch({
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
      } as never),
    );
    await Effect.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(threadId, 1),
      }),
    );
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v3\n", "utf8");

    const messagesBefore = await Effect.runPromise(
      harness.snapshotQuery.getThreadDetailById(threadId),
    );
    const countBefore = Option.isSome(messagesBefore) ? messagesBefore.value.messages.length : 0;
    expect(countBefore).toBeGreaterThan(0);

    // Restore files to turn 1 (v2).
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.files.restore",
        commandId: CommandId.make("cmd-files-restore"),
        threadId,
        turnCount: NonNegativeInt.make(1),
        createdAt: "2026-01-01T00:03:00.000Z",
      }),
    );

    await waitFor(async () => fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8") === "v2\n");

    // The working tree moved back, but the conversation is untouched.
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
    const messagesAfter = await Effect.runPromise(
      harness.snapshotQuery.getThreadDetailById(threadId),
    );
    const countAfter = Option.isSome(messagesAfter) ? messagesAfter.value.messages.length : 0;
    expect(countAfter).toBe(countBefore);
  });
});
