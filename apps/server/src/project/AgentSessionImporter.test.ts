import { expect, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ApplicationStoredEvent,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import {
  previousConversationRun,
  threadStartResumeAt,
} from "../orchestration-v2/ThreadRewindTargets.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import {
  CLAUDE_MODEL_SELECTION,
  CODEX_MODEL_SELECTION,
} from "../orchestration-v2/testkit/fixtures/shared.ts";
import { claudeTurnRunInT3Code } from "../orchestration-v2/testkit/ImportedThreadFixtures.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionResume from "./AgentSessionResume.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ClaudeSessionSources from "./ClaudeSessionSources.ts";
import * as ImportedRewindHeal from "./ImportedRewindHeal.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("agent-session-import-project");
const timestamp = "2026-09-01T10:00:00.000Z";
const now = DateTime.makeUnsafe(timestamp);
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const persistence = Layer.mergeAll(
  stores,
  EventSink.layer.pipe(Layer.provide(stores)),
  ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  IdAllocator.layer,
);

function candidate(
  modelSelection: typeof CODEX_MODEL_SELECTION,
  providerSessionId: string,
  provider: "codex" | "claudeAgent" = "codex",
) {
  const providerInstanceId = modelSelection.instanceId;
  return {
    _tag: "Importable" as const,
    source: {
      provider,
      providerInstanceId,
      providerSessionId,
      filePath: `/tmp/${providerInstanceId}/${providerSessionId}.jsonl`,
      size: 100,
      mtimeMs: 2,
      device: 3,
      inode: 4,
      birthtimeMs: 1,
    },
    thread: {
      source: provider,
      providerInstanceId,
      providerSessionId,
      title: "Imported thread",
      model: modelSelection.model,
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [
        { role: "user" as const, text: "Fix it", createdAt: timestamp },
        { role: "assistant" as const, text: "Fixed", createdAt: timestamp },
      ],
    },
  } satisfies AgentSessionScanner.AgentSessionRecentThread;
}

function importId(source: ReturnType<typeof candidate>) {
  return ThreadId.make(
    `import:${source.source.providerInstanceId}:${source.source.providerSessionId}`,
  );
}

const seedOwner = Effect.fn(function* (
  source: ReturnType<typeof candidate>,
  lifecycle: "active" | "archived" | "deleted" = "active",
) {
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const { providerInstanceId, providerSessionId, provider } = source.source;
  const threadId = ThreadId.make(`owner:${providerInstanceId}:${providerSessionId}`);
  const driver = ProviderDriverKind.make(provider);
  const providerThread: OrchestrationV2ProviderThread = {
    id: ids.derive.providerThread({
      driver,
      nativeThreadId: providerSessionId,
    }),
    driver,
    providerInstanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: providerSessionId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Native thread",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: source.thread.model },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: lifecycle === "archived" ? now : null,
    deletedAt: lifecycle === "deleted" ? now : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
  };
  yield* sink.write({
    events: [
      {
        id: EventId.make(`${threadId}:created`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      },
      {
        id: EventId.make(`${threadId}:provider`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: providerThread,
      },
    ],
  });
  return threadId;
});

const makeImporter = Effect.fn(function* (
  candidates: ReadonlyArray<ReturnType<typeof candidate>>,
  beforeTransaction: Effect.Effect<void> = Effect.void,
) {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* EventStore.EventStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const published: Array<ApplicationStoredEvent> = [];
  const withTransaction: typeof sql.withTransaction = (effect) =>
    beforeTransaction.pipe(Effect.andThen(sql.withTransaction(effect)));
  const importSql = new Proxy(sql, {
    get: (target, key, receiver) =>
      key === "withTransaction" ? withTransaction : Reflect.get(target, key, receiver),
  });
  const sinkLayer = Layer.fresh(EventSink.layer).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(SqlClient.SqlClient, importSql),
        Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
        Layer.succeed(EventStore.EventStoreV2, {
          ...events,
          publishCommitted: (batch) =>
            events.publishCommitted(batch).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  published.push(...batch);
                }),
              ),
            ),
        }),
      ),
    ),
  );
  const context = yield* Layer.build(
    AgentSessionImporter.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          sinkLayer,
          Layer.succeed(IdAllocator.IdAllocatorV2, yield* IdAllocator.IdAllocatorV2),
          Layer.succeed(
            ProviderSessionRuntime.ProviderSessionRuntimeRepository,
            yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository,
          ),
          Layer.mock(AgentSessionScanner.AgentSessionScanner)({
            recentThreads: () => Stream.fromIterable(candidates),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeed(
                Option.some({
                  id: projectId,
                  title: "Project",
                  workspaceRoot: "/workspace/project",
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: timestamp,
                  updatedAt: timestamp,
                  deletedAt: null,
                }),
              ),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: (threadId, fields) =>
              projections
                .getThreadRecords(threadId, fields)
                .pipe(
                  Effect.mapError(
                    (cause) => new Orchestrator.OrchestratorProjectionError({ threadId, cause }),
                  ),
                ),
          }),
        ),
      ),
    ),
  );
  const importer = Context.get(context, AgentSessionImporter.AgentSessionImporter);
  return { run: importer.importRecentAgentThreads({ projectId }), published };
});

it.effect(
  "ignores owned sessions, including archived and deleted threads, but imports other instances and unowned sessions",
  () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* EventStore.EventStoreV2;
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const active = candidate(CODEX_MODEL_SELECTION, "active");
      const archived = candidate(
        CLAUDE_MODEL_SELECTION,
        "020e7f00-dce6-406b-8ec6-ed90498945d6",
        "claudeAgent",
      );
      const deleted = candidate(CODEX_MODEL_SELECTION, "deleted");
      const owners = [
        yield* seedOwner(active),
        yield* seedOwner(archived, "archived"),
        yield* seedOwner(deleted, "deleted"),
      ];
      const before = yield* Effect.forEach(owners, (id) =>
        projections.getThreadRecords(id, ["providerThreads"]),
      );
      const otherInstance = candidate(
        { ...CLAUDE_MODEL_SELECTION, instanceId: ProviderInstanceId.make("claude-other") },
        archived.source.providerSessionId,
        "claudeAgent",
      );
      const unowned = candidate(CODEX_MODEL_SELECTION, "unowned");
      const importer = yield* makeImporter([active, archived, deleted, otherInstance, unowned]);

      expect(yield* importer.run).toEqual({ importedCount: 2, skippedCount: 0 });
      for (const source of [active, archived, deleted]) {
        const threadId = importId(source);
        expect(yield* Effect.option(projections.getThread(threadId))).toEqual(Option.none());
        expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual([]);
        expect(yield* runtimes.getByThreadId({ threadId })).toEqual(Option.none());
      }
      expect(
        yield* Effect.forEach(owners, (id) =>
          projections.getThreadRecords(id, ["providerThreads"]),
        ),
      ).toEqual(before);
      expect(
        new Set(
          importer.published.flatMap((stored) =>
            "event" in stored ? [stored.event.threadId] : [],
          ),
        ),
      ).toEqual(new Set([importId(otherInstance), importId(unowned)]));
      for (const source of [otherInstance, unowned]) {
        const threadId = importId(source);
        const records = yield* projections.getThreadRecords(threadId, [
          "messages",
          "providerThreads",
        ]);
        expect(records.messages.map((message) => message.text)).toEqual(["Fix it", "Fixed"]);
        expect(records.thread.historyOrigin).toBe("v1_import");
        expect(records.thread.activeProviderThreadId).toBe(records.providerThreads[0]?.id);
        expect(records.providerThreads[0]?.nativeThreadRef?.nativeId).toBe(
          source.source.providerSessionId,
        );
        expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
          providerInstanceId: source.source.providerInstanceId,
          resumeCursor:
            source.source.provider === "codex"
              ? { threadId: source.source.providerSessionId }
              : { threadId, resume: source.source.providerSessionId },
          runtimePayload: { importedTranscripts: [source.source] },
        });
      }
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("rechecks ownership after the import reaches the commit transaction", () =>
  Effect.gen(function* () {
    const enteringTransaction = yield* Deferred.make<void>();
    const continueTransaction = yield* Deferred.make<void>();
    const source = candidate(CODEX_MODEL_SELECTION, "claimed-during-import");
    const importer = yield* makeImporter(
      [source],
      Deferred.succeed(enteringTransaction, undefined).pipe(
        Effect.andThen(Deferred.await(continueTransaction)),
      ),
    );
    const pending = yield* Effect.forkScoped(importer.run);
    yield* Deferred.await(enteringTransaction);
    // Commit ownership after all pre-transaction reads, before the import acquires SQLite.
    const ownerId = yield* seedOwner(source);
    yield* Deferred.succeed(continueTransaction, undefined);
    expect(yield* Fiber.join(pending)).toEqual({ importedCount: 0, skippedCount: 0 });
    expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 0 });
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventStore.EventStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    expect(yield* Effect.option(projections.getThread(importId(source)))).toEqual(Option.none());
    expect(yield* events.read({ threadId: importId(source) }).pipe(Stream.runCollect)).toEqual([]);
    expect(yield* runtimes.list()).toEqual([]);
    expect(importer.published).toEqual([]);
    expect(
      (yield* projections.getThreadRecords(ownerId, ["providerThreads"])).providerThreads[0]
        ?.appThreadId,
    ).toBe(ownerId);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "retries failed commits and runtime persistence without replaying committed history",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const events = yield* EventStore.EventStoreV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const source = candidate(CODEX_MODEL_SELECTION, "retry");
      const threadId = importId(source);
      const importer = yield* makeImporter([source]);
      yield* sql`CREATE TEMP TRIGGER fail_import BEFORE INSERT ON orchestration_events WHEN NEW.event_type = 'message.updated' BEGIN SELECT RAISE(ABORT, 'test publication failure'); END`;
      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 1 });
      expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual([]);
      expect(yield* Effect.option(projections.getThread(threadId))).toEqual(Option.none());
      expect(yield* runtimes.list()).toEqual([]);
      expect(importer.published).toEqual([]);
      yield* sql`DROP TRIGGER fail_import`;

      yield* sql`CREATE TEMP TRIGGER fail_runtime BEFORE INSERT ON provider_session_runtime BEGIN SELECT RAISE(ABORT, 'test runtime failure'); END`;
      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 1 });
      const committed = yield* events.read({ threadId }).pipe(Stream.runCollect);
      expect(committed).toHaveLength(6);
      expect(importer.published).toHaveLength(6);
      expect(yield* runtimes.list()).toEqual([]);
      yield* sql`DROP TRIGGER fail_runtime`;

      expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });
      expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });
      expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual(committed);
      expect(importer.published).toHaveLength(6);
      expect(
        (yield* projections.getThreadRecords(threadId, ["messages"])).messages.map(
          (message) => message.text,
        ),
      ).toEqual(["Fix it", "Fixed"]);
      expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
        providerInstanceId: source.source.providerInstanceId,
        resumeCursor: { threadId: source.source.providerSessionId },
        runtimePayload: { importedTranscripts: [source.source] },
      });
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

const providerInstanceId = ProviderInstanceId.make("codex");
const providerSessionId = "native-codex-thread";
const threadId = ThreadId.make(`import:${providerInstanceId}:${providerSessionId}`);

it.effect(
  "imports into the active list and later appends only the messages it has not seen",
  () => {
    const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
    let runs: Array<unknown> = [];
    const messages = new Map<string, unknown>();
    const claudeSessionId = "11111111-1111-4111-8111-111111111111";
    const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
    const claudeThreadId = ThreadId.make(`import:${claudeInstanceId}:${claudeSessionId}`);
    const source = {
      provider: "claudeAgent" as const,
      providerInstanceId: claudeInstanceId,
      providerSessionId: claudeSessionId,
      filePath: "/tmp/session.jsonl",
      size: 100,
      mtimeMs: 2,
      device: 3,
      inode: 4,
      birthtimeMs: 1,
    };
    const thread = (texts: ReadonlyArray<string>) => ({
      source: "claudeAgent" as const,
      providerInstanceId: claudeInstanceId,
      providerSessionId: claudeSessionId,
      title: "Desktop chat",
      model: null,
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T10:01:00.000Z",
      messages: texts.map((text, index) => ({
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        text,
        createdAt: "2026-09-01T10:00:00.000Z",
      })),
    });
    const layerTest = AgentSessionImporter.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(AgentSessionScanner.AgentSessionScanner)({}),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: () =>
              writes.length === 0
                ? Effect.fail(
                    new Orchestrator.OrchestratorProjectionError({ threadId: claudeThreadId }),
                  )
                : Effect.succeed({
                    thread: {
                      id: claudeThreadId,
                      projectId,
                      historyOrigin: "v1_import",
                      deletedAt: null,
                    },
                    runs,
                    messages: [...messages.values()],
                    providerThreads: [],
                    providerTurns: [],
                  } as never),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            write: (input) =>
              Effect.sync(() => {
                writes.push(input.events);
                for (const event of input.events) {
                  if (event.type === "message.updated")
                    messages.set(event.payload.id, event.payload);
                }
                return [];
              }),
          }),
          Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
            upsert: () => Effect.void,
            recordImportedTranscript: () => Effect.void,
          }),
          IdAllocator.layer,
        ),
      ),
    );

    return Effect.gen(function* () {
      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      yield* importer.importThread({
        projectId,
        workspaceRoot: "/workspace/project",
        threadId: claudeThreadId,
        thread: thread(["Fix it", "Fixed"]),
        source,
        activeAt: DateTime.makeUnsafe("2026-10-05T09:00:00.000Z"),
      });
      const created = writes[0]?.find((event) => event.type === "thread.created");
      expect(created?.payload).toMatchObject({ settledOverride: "active", settledAt: null });
      expect(
        created?.type === "thread.created" && created.payload.unsettledAt != null
          ? DateTime.formatIso(created.payload.unsettledAt)
          : null,
      ).toBe("2026-10-05T09:00:00.000Z");

      const longer = thread(["Fix it", "Fixed", "Now the header", "Done"]);
      expect(
        yield* importer.appendImportedMessages({
          threadId: claudeThreadId,
          thread: longer,
          source,
        }),
      ).toBe(2);
      expect(
        writes[1]
          ?.filter((event) => event.type === "message.updated")
          .map((event) => event.payload.text),
      ).toEqual(["Now the header", "Done"]);
      expect(
        yield* importer.appendImportedMessages({
          threadId: claudeThreadId,
          thread: longer,
          source,
        }),
      ).toBe(0);

      // Once a turn ran in T3 Code, its copy of the session is the live one.
      runs = [{ userMessageId: "message-sent-in-t3", status: "completed" }];
      expect(
        yield* importer.appendImportedMessages({
          threadId: claudeThreadId,
          thread: thread(["Fix it", "Fixed", "Now the header", "Done", "More"]),
          source,
        }),
      ).toBe(0);
      expect(yield* importer.isUntouchedImport(claudeThreadId)).toBe(false);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect("imports a transcript with background tool calls as a thread at rest", () => {
  const claudeSessionId = "22222222-2222-4222-8222-222222222222";
  const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
  const claudeThreadId = ThreadId.make(`import:${claudeInstanceId}:${claudeSessionId}`);
  const record = (at: string, type: "user" | "assistant", content: unknown) =>
    JSON.stringify({
      type,
      sessionId: claudeSessionId,
      cwd: "/workspace/project",
      isSidechain: false,
      timestamp: at,
      message:
        type === "user"
          ? { role: "user", content }
          : { role: "assistant", model: "claude-opus-5", type: "message", content },
    });
  const toolUse = (id: string, name: string, input: unknown) => ({
    type: "tool_use",
    id,
    name,
    input,
  });
  // Shapes copied from Claude Code transcripts: background Bash, Monitor and a
  // background Agent start whose completions never appear in the transcript.
  const contents = [
    record("2026-09-01T10:00:00.000Z", "user", "Run the checks"),
    record("2026-09-01T10:00:01.000Z", "assistant", [
      toolUse("toolu_bash", "Bash", {
        command: "pnpm typecheck 2>&1 | tail -30",
        description: "Run typecheck",
        run_in_background: true,
      }),
    ]),
    record("2026-09-01T10:00:02.000Z", "user", [
      { tool_use_id: "toolu_bash", type: "tool_result", content: "Command running in background" },
    ]),
    record("2026-09-01T10:00:03.000Z", "assistant", [
      toolUse("toolu_monitor", "Monitor", {
        command: "until grep -q done /tmp/out; do sleep 5; done",
        description: "typecheck finishes",
        timeout_ms: 300000,
        persistent: false,
      }),
      toolUse("toolu_agent", "Agent", {
        subagent_type: "Explore",
        description: "Trace the bug",
        prompt: "Find the cause",
        run_in_background: true,
      }),
    ]),
    record("2026-09-01T10:00:04.000Z", "assistant", [
      { type: "text", text: "Checks are running." },
    ]),
  ].join("\n");
  const thread = AgentSessionScanner.parseAgentSessionTranscript({
    source: "claudeAgent",
    providerInstanceId: claudeInstanceId,
    fallbackSessionId: claudeSessionId,
    lastActiveAtMs: Date.parse("2026-09-01T10:00:04.000Z"),
    contents,
  });
  const storeLayer = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
  const importerLayer = Layer.unwrap(
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      return AgentSessionImporter.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(AgentSessionScanner.AgentSessionScanner)({}),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(Orchestrator.OrchestratorV2)({
              getThreadRecords: () =>
                Effect.fail(
                  new Orchestrator.OrchestratorProjectionError({ threadId: claudeThreadId }),
                ),
            }),
            Layer.mock(EventSink.EventSinkV2)({
              write: (input) =>
                Effect.forEach(input.events, (event) => store.apply(event)).pipe(
                  Effect.as([]),
                  Effect.orDie,
                ),
            }),
            Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
              upsert: () => Effect.void,
              recordImportedTranscript: () => Effect.void,
            }),
            IdAllocator.layer,
          ),
        ),
      );
    }),
  );

  return Effect.gen(function* () {
    expect(thread?.messages.map((message) => message.text)).toEqual([
      "Run the checks",
      "Checks are running.",
    ]);
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    yield* importer.importThread({
      projectId,
      workspaceRoot: "/workspace/project",
      threadId: claudeThreadId,
      thread: thread!,
      source: {
        provider: "claudeAgent",
        providerInstanceId: claudeInstanceId,
        providerSessionId: claudeSessionId,
        filePath: "/tmp/session.jsonl",
        size: contents.length,
        mtimeMs: 2,
        device: 3,
        inode: 4,
        birthtimeMs: 1,
      },
      activeAt: DateTime.makeUnsafe("2026-10-05T09:00:00.000Z"),
    });
    const shell = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadShell(claudeThreadId);
    expect(shell).toMatchObject({
      activeRunId: null,
      status: "idle",
      pendingBackgroundTasks: [],
    });
  }).pipe(Effect.provide(Layer.provideMerge(importerLayer, storeLayer)));
});

const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
const rewindSessionId = "33333333-3333-4333-8333-333333333333";
const rewindThreadId = ThreadId.make(`import:${claudeInstanceId}:${rewindSessionId}`);
const rewindSource = {
  provider: "claudeAgent" as const,
  providerInstanceId: claudeInstanceId,
  providerSessionId: rewindSessionId,
  filePath: "/tmp/rewind-session.jsonl",
  size: 100,
  mtimeMs: 2,
  device: 3,
  inode: 4,
  birthtimeMs: 1,
};

/** A Claude Code transcript as written to disk: prompt, tool call, tool result, reply. */
function claudeTranscript(
  turns: ReadonlyArray<{ readonly prompt: string; readonly reply?: string }>,
): string {
  let parentUuid: string | null = null;
  let second = 0;
  const records: Array<Record<string, unknown>> = [];
  const push = (record: Record<string, unknown>) => {
    const uuid = record.uuid as string;
    records.push({
      sessionId: rewindSessionId,
      cwd: "/workspace/project",
      isSidechain: false,
      parentUuid,
      timestamp: DateTime.formatIso(
        DateTime.add(DateTime.makeUnsafe("2026-09-01T10:00:00.000Z"), { seconds: second++ }),
      ),
      ...record,
    });
    parentUuid = uuid;
  };
  turns.forEach(({ prompt, reply }, index) => {
    const n = index + 1;
    push({ type: "user", uuid: `prompt-${n}`, message: { role: "user", content: prompt } });
    records.push({
      type: "file-history-snapshot",
      messageId: `prompt-${n}`,
      snapshot: { messageId: `prompt-${n}`, trackedFileBackups: {} },
      isSnapshotUpdate: false,
    });
    if (reply === undefined) return;
    push({
      type: "assistant",
      uuid: `reply-${n}-tool`,
      message: { role: "assistant", model: "claude-opus-5", content: [{ type: "tool_use" }] },
    });
    push({
      type: "user",
      uuid: `tool-result-${n}`,
      message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
    });
    push({
      type: "assistant",
      uuid: `reply-${n}`,
      message: {
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "text", text: reply }],
      },
    });
  });
  return records.map((record) => JSON.stringify(record)).join("\n");
}

function parseClaudeTranscript(
  contents: string,
  options?: { readonly allMessages?: boolean },
): AgentSessionScanner.AgentSessionThread {
  const thread = AgentSessionScanner.parseAgentSessionTranscript({
    source: "claudeAgent",
    providerInstanceId: claudeInstanceId,
    fallbackSessionId: rewindSessionId,
    lastActiveAtMs: Date.parse("2026-09-01T11:00:00.000Z"),
    contents,
    ...options,
  });
  if (thread === null) throw new Error("transcript did not parse");
  return thread;
}

/** The importer and the rewind heal over a real projection store, as the server runs them. */
const storeBackedImporter = (input?: {
  readonly scanner?: Partial<AgentSessionScanner.AgentSessionScanner["Service"]>;
  readonly runtimes?: Partial<ProviderSessionRuntime.ProviderSessionRuntimeRepository["Service"]>;
}) => {
  const storeLayer = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
  const runtimesLayer = Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
    upsert: () => Effect.void,
    recordImportedTranscript: () => Effect.void,
    list: () => Effect.succeed([]),
    ...input?.runtimes,
  });
  const importerLayer = Layer.unwrap(
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      return AgentSessionImporter.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(AgentSessionScanner.AgentSessionScanner)(input?.scanner ?? {}),
            Layer.mock(ProjectService.ProjectService)({
              getById: () =>
                Effect.succeed(
                  Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
                ),
            }),
            Layer.mock(Orchestrator.OrchestratorV2)({
              getThreadRecords: (threadId, fields, filter) =>
                store
                  .getThreadRecords(threadId, fields, filter)
                  .pipe(
                    Effect.mapError(
                      () => new Orchestrator.OrchestratorProjectionError({ threadId }),
                    ),
                  ),
            }),
            Layer.mock(EventSink.EventSinkV2)({
              write: (write) =>
                Effect.forEach(write.events, (event) => store.apply(event)).pipe(
                  Effect.as([]),
                  Effect.orDie,
                ),
            }),
            runtimesLayer,
            IdAllocator.layer,
          ),
        ),
      );
    }),
  );
  return ImportedRewindHeal.layer.pipe(
    Layer.provideMerge(importerLayer),
    Layer.provide(runtimesLayer),
    Layer.provideMerge(storeLayer),
  );
};

/**
 * What a rewind to just before each prompt of an imported thread would use:
 * the Claude uuid the resumed session continues after (null: the session
 * starts over) and the prompt uuid Claude restores files by.
 */
const rewindPoints = Effect.fn("rewindPoints")(function* (threadId: ThreadId) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const records = yield* store.getThreadRecords(threadId, [
    "messages",
    "runs",
    "attempts",
    "providerTurns",
  ]);
  const turnOf = (run: OrchestrationV2Run) => {
    const attempt = records.attempts.find((candidate) => candidate.id === run.activeAttemptId);
    return records.providerTurns.find((turn) => turn.runAttemptId === attempt?.id);
  };
  return records.messages
    .filter((message) => message.role === "user")
    .map((message) => {
      const run = records.runs.find((candidate) => candidate.userMessageId === message.id);
      if (run === undefined) return { prompt: message.text, rewind: "none" as const };
      const previous = previousConversationRun(records.runs, run);
      return {
        prompt: message.text,
        resumeAfter:
          previous === undefined
            ? (threadStartResumeAt(records.providerTurns, turnOf(run)!.providerThreadId) ?? null)
            : (turnOf(previous)?.nativeTurnRef?.nativeId ?? "missing"),
        restoreFilesBy: turnOf(run)?.nativeUserMessageId ?? "missing",
        hiddenWithIt: records.messages
          .filter((candidate) => candidate.runId === run.id)
          .map((candidate) => candidate.text),
      };
    });
});

it.effect("gives every prompt of a new Claude import a rewind point", () =>
  Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    yield* importer.importThread({
      projectId,
      workspaceRoot: "/workspace/project",
      threadId: rewindThreadId,
      thread: parseClaudeTranscript(
        claudeTranscript([
          { prompt: "Create notes.md", reply: "Created notes.md." },
          { prompt: "Add a title", reply: "Added the title." },
        ]),
      ),
      source: rewindSource,
    });

    expect(yield* rewindPoints(rewindThreadId)).toEqual([
      {
        prompt: "Create notes.md",
        resumeAfter: null,
        restoreFilesBy: "prompt-1",
        hiddenWithIt: ["Create notes.md", "Created notes.md."],
      },
      {
        prompt: "Add a title",
        resumeAfter: "reply-1",
        restoreFilesBy: "prompt-2",
        hiddenWithIt: ["Add a title", "Added the title."],
      },
    ]);
    const shell = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadShell(rewindThreadId);
    // At rest like a native thread whose last turn finished, so it reads as ready.
    expect(shell).toMatchObject({ activeRunId: null, status: "completed" });
  }).pipe(Effect.provide(storeBackedImporter())),
);

it.effect("keeps rewind points current as the desktop app's transcript grows", () =>
  Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    yield* importer.importThread({
      projectId,
      workspaceRoot: "/workspace/project",
      threadId: rewindThreadId,
      // Imported while Claude was still on the first prompt.
      thread: parseClaudeTranscript(claudeTranscript([{ prompt: "Create notes.md" }])),
      source: rewindSource,
    });
    const grown = parseClaudeTranscript(
      claudeTranscript([
        { prompt: "Create notes.md", reply: "Created notes.md." },
        { prompt: "Add a title", reply: "Added the title." },
      ]),
    );

    expect(
      yield* importer.appendImportedMessages({
        threadId: rewindThreadId,
        thread: grown,
        source: rewindSource,
      }),
    ).toBe(3);
    expect(
      yield* importer.appendImportedMessages({
        threadId: rewindThreadId,
        thread: grown,
        source: rewindSource,
      }),
    ).toBe(0);

    expect(yield* rewindPoints(rewindThreadId)).toEqual([
      expect.objectContaining({ prompt: "Create notes.md", resumeAfter: null }),
      {
        prompt: "Add a title",
        resumeAfter: "reply-1",
        restoreFilesBy: "prompt-2",
        hiddenWithIt: ["Add a title", "Added the title."],
      },
    ]);
    expect(yield* importer.isUntouchedImport(rewindThreadId)).toBe(true);
  }).pipe(Effect.provide(storeBackedImporter())),
);

it.effect("heals chats imported before rewind points, once, from their transcripts", () => {
  const transcript = parseClaudeTranscript(
    claudeTranscript([
      { prompt: "Create notes.md", reply: "Created notes.md." },
      { prompt: "Add a title", reply: "Added the title." },
    ]),
  );
  // What the importer wrote before it kept transcript uuids.
  const beforeRewindPoints = {
    ...transcript,
    messages: transcript.messages.map(
      ({ nativeUserMessageId: _id, nativeTurnId: _turn, ...message }) => message,
    ),
  };
  const nativeThreadId = ThreadId.make("thread-started-in-t3");
  const reads: Array<string> = [];
  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const heal = yield* ImportedRewindHeal.ImportedRewindHeal;
    yield* importer.importThread({
      projectId,
      workspaceRoot: "/workspace/project",
      threadId: rewindThreadId,
      thread: beforeRewindPoints,
      source: rewindSource,
    });
    expect(yield* rewindPoints(rewindThreadId)).toEqual([
      { prompt: "Create notes.md", rewind: "none" },
      { prompt: "Add a title", rewind: "none" },
    ]);

    expect(yield* heal.run()).toBe(1);
    expect(yield* rewindPoints(rewindThreadId)).toEqual([
      {
        prompt: "Create notes.md",
        resumeAfter: null,
        restoreFilesBy: "prompt-1",
        hiddenWithIt: ["Create notes.md", "Created notes.md."],
      },
      {
        prompt: "Add a title",
        resumeAfter: "reply-1",
        restoreFilesBy: "prompt-2",
        hiddenWithIt: ["Add a title", "Added the title."],
      },
    ]);

    const store = yield* ProjectionStore.ProjectionStoreV2;
    const before = yield* store.getThreadRecords(rewindThreadId, ["messages", "runs"]);
    expect(yield* heal.run()).toBe(0);
    const after = yield* store.getThreadRecords(rewindThreadId, ["messages", "runs"]);
    expect(after.messages).toEqual(before.messages);
    expect(after.runs).toEqual(before.runs);
    // A thread started in T3 Code is never read, and a healed one is not read again.
    expect(reads).toEqual([rewindSource.filePath]);
  }).pipe(
    Effect.provide(
      storeBackedImporter({
        runtimes: {
          list: () =>
            Effect.succeed([
              {
                threadId: nativeThreadId,
                providerName: "claudeAgent",
                runtimePayload: { importedTranscripts: [{ ...rewindSource, filePath: "/native" }] },
              },
              {
                threadId: rewindThreadId,
                providerName: "claudeAgent",
                runtimePayload: { cwd: "/workspace/project", importedTranscripts: [rewindSource] },
              },
            ] as never),
        },
        scanner: {
          readThread: (input) =>
            Effect.sync(() => {
              reads.push(input.filePath);
              return Option.some({ thread: transcript, source: rewindSource });
            }),
        },
      }),
    ),
  );
});

it.live("a first turn sent while the heal reads the transcript keeps its own run", () => {
  const transcript = parseClaudeTranscript(
    claudeTranscript([
      { prompt: "Create notes.md", reply: "Created notes.md." },
      { prompt: "Add a title", reply: "Added the title." },
    ]),
  );
  const beforeRewindPoints = {
    ...transcript,
    messages: transcript.messages.map(
      ({ nativeUserMessageId: _id, nativeTurnId: _turn, ...message }) => message,
    ),
  };
  return Effect.gen(function* () {
    const reading = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const importerLayer = storeBackedImporter({
      runtimes: {
        list: () =>
          Effect.succeed([
            {
              threadId: rewindThreadId,
              providerName: "claudeAgent",
              runtimePayload: { cwd: "/workspace/project", importedTranscripts: [rewindSource] },
            },
          ] as never),
      },
      scanner: {
        readThread: () =>
          Deferred.succeed(reading, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(Option.some({ thread: transcript, source: rewindSource })),
          ),
      },
    });
    yield* Effect.gen(function* () {
      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      const heal = yield* ImportedRewindHeal.ImportedRewindHeal;
      const threadLocks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      yield* importer.importThread({
        projectId,
        workspaceRoot: "/workspace/project",
        threadId: rewindThreadId,
        thread: beforeRewindPoints,
        source: rewindSource,
      });

      const healing = yield* Effect.forkChild(heal.run());
      yield* Deferred.await(reading);
      // What starting a turn does under the thread's dispatch lock: the next
      // ordinal, and the run id the orchestrator derives from it.
      const firstTurn = yield* Effect.forkChild(
        threadLocks.withLock(
          rewindThreadId,
          Effect.gen(function* () {
            const records = yield* store.getThreadRecords(rewindThreadId, [
              "runs",
              "providerThreads",
            ]);
            const ordinal = records.runs.length + 1;
            const events = claudeTurnRunInT3Code({
              providerThread: records.providerThreads[0]!,
              ordinal,
              providerTurnOrdinal: ordinal,
              prompt: "Sent right after the restart",
              reply: "Done in T3 Code.",
              nativeReplyId: "reply-live",
              at: "2026-09-02T09:00:00.000Z",
              runId: ids.derive.run({ threadId: rewindThreadId, ordinal }),
            });
            yield* Effect.forEach(events, (event) => store.apply(event));
          }),
        ),
      );
      // Give the turn every chance to land while the heal is still reading.
      yield* Fiber.await(firstTurn).pipe(Effect.timeoutOption("200 millis"));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(healing);
      yield* Fiber.join(firstTurn);

      const records = yield* store.getThreadRecords(rewindThreadId, ["messages", "runs"]);
      expect(
        records.messages
          .filter((message) => message.role === "user")
          .map((message) => ({
            prompt: message.text,
            ownRun:
              records.runs.find((run) => run.id === message.runId)?.userMessageId === message.id,
          })),
      ).toEqual([
        { prompt: "Create notes.md", ownRun: true },
        { prompt: "Add a title", ownRun: true },
        { prompt: "Sent right after the restart", ownRun: true },
      ]);
      expect(new Set(records.runs.map((run) => run.ordinal)).size).toBe(3);
    }).pipe(
      Effect.provide(Layer.mergeAll(importerLayer, ThreadCommandExecutor.layer, IdAllocator.layer)),
    );
  });
});

it.live("a first turn sent while the mirror appends desktop messages keeps its own run", () => {
  const imported = parseClaudeTranscript(
    claudeTranscript([{ prompt: "Create notes.md", reply: "Created notes.md." }]),
  );
  // The desktop app went on in the same session after the import.
  const grown = parseClaudeTranscript(
    claudeTranscript([
      { prompt: "Create notes.md", reply: "Created notes.md." },
      { prompt: "Add a title", reply: "Added the title." },
    ]),
  );
  const claudeHome = "/claude-home";
  const workspaceRoot = "/workspace/project";
  // Already in T3 Code's Claude home, so the hand-off copies nothing.
  const transcriptPath = `${claudeHome}/projects/${ClaudeSessionSources.encodeClaudeProjectDir(workspaceRoot)}/${rewindSessionId}.jsonl`;
  const scanner = {
    providerHomes: () =>
      Effect.succeed([{ providerInstanceId: claudeInstanceId, homePath: claudeHome }] as never),
    readThread: () => Effect.succeedSome({ thread: grown, source: rewindSource }),
  };
  const importerLayer = storeBackedImporter({ scanner });
  const resumeLayer = AgentSessionResume.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        importerLayer,
        Layer.mock(AgentSessionScanner.AgentSessionScanner)(scanner),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ServerSettingsService)({}),
        FileSystem.layerNoop({}),
        Path.layer,
      ),
    ),
  );
  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const resume = yield* AgentSessionResume.AgentSessionResume;
    const threadLocks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    yield* importer.importThread({
      projectId,
      workspaceRoot,
      threadId: rewindThreadId,
      thread: imported,
      source: rewindSource,
    });

    const planned = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    // What starting a turn does under the thread's dispatch lock: read the
    // next ordinal, do the work of starting the turn, then write its run.
    const firstTurn = yield* Effect.forkChild(
      threadLocks.withLock(
        rewindThreadId,
        Effect.gen(function* () {
          const records = yield* store.getThreadRecords(rewindThreadId, [
            "runs",
            "providerThreads",
          ]);
          const ordinal = records.runs.length + 1;
          yield* Deferred.succeed(planned, undefined);
          yield* Deferred.await(release);
          const events = claudeTurnRunInT3Code({
            providerThread: records.providerThreads[0]!,
            ordinal,
            providerTurnOrdinal: ordinal,
            prompt: "Sent from T3 Code",
            reply: "Done in T3 Code.",
            nativeReplyId: "reply-live",
            at: "2026-09-02T09:00:00.000Z",
            runId: ids.derive.run({ threadId: rewindThreadId, ordinal }),
          });
          yield* Effect.forEach(events, (event) => store.apply(event));
        }),
      ),
    );
    yield* Deferred.await(planned);
    const mirroring = yield* Effect.forkChild(
      resume.refreshSession({
        project: { id: projectId, workspaceRoot },
        session: {
          providerSessionId: rewindSessionId,
          title: "Rewind session",
          updatedAtMs: 2,
          origin: "desktop",
          archived: false,
          transcriptPath,
          cwd: workspaceRoot,
        },
        threadId: rewindThreadId,
      }),
    );
    // Give the mirror every chance to append while the turn is being started.
    yield* Fiber.await(mirroring).pipe(Effect.timeoutOption("200 millis"));
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(firstTurn);
    yield* Fiber.join(mirroring);

    const records = yield* store.getThreadRecords(rewindThreadId, ["messages", "runs"]);
    const prompts = records.messages
      .filter((message) => message.role === "user")
      .map((message) => ({
        prompt: message.text,
        ownRun: records.runs.find((run) => run.id === message.runId)?.userMessageId === message.id,
      }));
    expect(prompts).toContainEqual({ prompt: "Sent from T3 Code", ownRun: true });
    expect(prompts.every((prompt) => prompt.ownRun)).toBe(true);
    expect(new Set(records.runs.map((run) => run.ordinal)).size).toBe(records.runs.length);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(resumeLayer, importerLayer, ThreadCommandExecutor.layer, IdAllocator.layer),
    ),
  );
});

/** `count` Claude turns, "Prompt n" answered by "Reply n", as the desktop app writes them. */
const longChat = (count: number) =>
  claudeTranscript(
    Array.from({ length: count }, (_, index) => ({
      prompt: `Prompt ${index + 1}`,
      reply: `Reply ${index + 1}`,
    })),
  );

/** What the importer wrote before it kept transcript uuids. */
const withoutRewindPoints = (
  thread: AgentSessionScanner.AgentSessionThread,
): AgentSessionScanner.AgentSessionThread => ({
  ...thread,
  messages: thread.messages.map(
    ({ nativeUserMessageId: _id, nativeTurnId: _turn, ...message }) => message,
  ),
});

/** A transcript the scanner reads capped, as imports and the mirror do, or whole. */
const transcriptReader = (contents: string, reads?: Array<{ readonly allMessages: boolean }>) => ({
  readThread: (input: { readonly allMessages?: boolean }) =>
    Effect.sync(() => {
      reads?.push({ allMessages: input.allMessages === true });
      return Option.some({
        thread: parseClaudeTranscript(contents, { allMessages: input.allMessages === true }),
        source: rewindSource,
      });
    }),
});

const importRow = {
  threadId: rewindThreadId,
  providerName: "claudeAgent",
  runtimePayload: { cwd: "/workspace/project", importedTranscripts: [rewindSource] },
};

it.effect("heals a long chat whose kept messages shifted since it was imported", () =>
  Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const heal = yield* ImportedRewindHeal.ImportedRewindHeal;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    // Imported at 110 turns: the first prompt, then the last 199 messages.
    yield* importer.importThread({
      projectId,
      workspaceRoot: "/workspace/project",
      threadId: rewindThreadId,
      thread: withoutRewindPoints(parseClaudeTranscript(longChat(110))),
      source: rewindSource,
    });
    const imported = yield* store.getThreadRecords(rewindThreadId, ["messages"]);
    expect(imported.messages.slice(0, 3).map((message) => message.text)).toEqual([
      "Prompt 1",
      "Reply 11",
      "Prompt 12",
    ]);

    // The desktop chat has since grown to 130 turns, so its newest 199 messages start later.
    expect(yield* heal.run()).toBe(1);

    const points = yield* rewindPoints(rewindThreadId);
    expect(points).toHaveLength(100);
    expect(points[0]).toEqual({
      prompt: "Prompt 1",
      resumeAfter: null,
      restoreFilesBy: "prompt-1",
      // Turns 2 to 10 were never shown; Claude's own session still holds them.
      hiddenWithIt: ["Prompt 1", "Reply 11"],
    });
    expect(points[1]).toEqual({
      prompt: "Prompt 12",
      resumeAfter: "reply-11",
      restoreFilesBy: "prompt-12",
      hiddenWithIt: ["Prompt 12", "Reply 12"],
    });
    expect(points.at(-1)).toEqual({
      prompt: "Prompt 110",
      resumeAfter: "reply-109",
      restoreFilesBy: "prompt-110",
      hiddenWithIt: ["Prompt 110", "Reply 110"],
    });
    expect(
      points.filter(
        (point) =>
          "restoreFilesBy" in point &&
          point.restoreFilesBy !== point.prompt.replace("Prompt ", "prompt-"),
      ),
    ).toEqual([]);
    const healed = yield* store.getThreadRecords(rewindThreadId, ["messages"]);
    expect(healed.messages.map((message) => message.text)).toEqual(
      imported.messages.map((message) => message.text),
    );

    const runs = (yield* store.getThreadRecords(rewindThreadId, ["runs"])).runs;
    expect(yield* heal.run()).toBe(0);
    expect((yield* store.getThreadRecords(rewindThreadId, ["runs"])).runs).toEqual(runs);
  }).pipe(
    Effect.provide(
      storeBackedImporter({
        runtimes: { list: () => Effect.succeed([importRow] as never) },
        scanner: transcriptReader(longChat(130)),
      }),
    ),
  ),
);

/** The desktop app writing the records of turns `from` to `to` of `contents` again, after them. */
const withRewrittenHistory = (contents: string, from: number, to: number) => {
  const lines = contents.split("\n");
  // claudeTranscript writes five records per answered turn.
  const block = lines.slice((from - 1) * 5, to * 5).map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    return JSON.stringify({ ...record, slug: "rewritten", gitBranch: "main", promptId: "again" });
  });
  return [...lines.slice(0, to * 5), ...block, ...lines.slice(to * 5)].join("\n");
};

it.effect("heals a chat whose transcript the desktop app wrote parts of again", () =>
  Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const heal = yield* ImportedRewindHeal.ImportedRewindHeal;
    yield* importer.importThread({
      projectId,
      workspaceRoot: "/workspace/project",
      threadId: rewindThreadId,
      thread: withoutRewindPoints(parseClaudeTranscript(longChat(3))),
      source: rewindSource,
    });

    expect(yield* heal.run()).toBe(1);

    expect(yield* rewindPoints(rewindThreadId)).toEqual([
      {
        prompt: "Prompt 1",
        resumeAfter: null,
        restoreFilesBy: "prompt-1",
        hiddenWithIt: ["Prompt 1", "Reply 1"],
      },
      {
        prompt: "Prompt 2",
        resumeAfter: "reply-1",
        restoreFilesBy: "prompt-2",
        hiddenWithIt: ["Prompt 2", "Reply 2"],
      },
      {
        prompt: "Prompt 3",
        resumeAfter: "reply-2",
        restoreFilesBy: "prompt-3",
        hiddenWithIt: ["Prompt 3", "Reply 3"],
      },
    ]);
  }).pipe(
    Effect.provide(
      storeBackedImporter({
        runtimes: { list: () => Effect.succeed([importRow] as never) },
        scanner: transcriptReader(withRewrittenHistory(longChat(3), 1, 2)),
      }),
    ),
  ),
);

it.effect("heals a chat whose first message is a reply from the turns before it", () =>
  Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const heal = yield* ImportedRewindHeal.ImportedRewindHeal;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const whole = parseClaudeTranscript(longChat(4));
    // Imported showing Reply 2 onward.
    yield* importer.importThread({
      projectId,
      workspaceRoot: "/workspace/project",
      threadId: rewindThreadId,
      thread: withoutRewindPoints({ ...whole, messages: whole.messages.slice(3) }),
      source: rewindSource,
    });

    expect(yield* heal.run()).toBe(1);

    expect(yield* rewindPoints(rewindThreadId)).toEqual([
      {
        prompt: "Prompt 3",
        // Rewinding the first prompt shown keeps the turns before it in the session.
        resumeAfter: "reply-2",
        restoreFilesBy: "prompt-3",
        hiddenWithIt: ["Prompt 3", "Reply 3"],
      },
      {
        prompt: "Prompt 4",
        resumeAfter: "reply-3",
        restoreFilesBy: "prompt-4",
        hiddenWithIt: ["Prompt 4", "Reply 4"],
      },
    ]);
    const { messages } = yield* store.getThreadRecords(rewindThreadId, ["messages"]);
    expect(messages.find((message) => message.text === "Reply 2")?.runId).toBeNull();
  }).pipe(
    Effect.provide(
      storeBackedImporter({
        runtimes: { list: () => Effect.succeed([importRow] as never) },
        scanner: transcriptReader(longChat(4)),
      }),
    ),
  ),
);

it.effect("keeps a long mirrored chat's messages and rewind points as it grows", () =>
  Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    yield* importer.importThread({
      projectId,
      workspaceRoot: "/workspace/project",
      threadId: rewindThreadId,
      thread: parseClaudeTranscript(longChat(110)),
      source: rewindSource,
    });
    const imported = yield* store.getThreadRecords(rewindThreadId, ["messages"]);
    const before = yield* rewindPoints(rewindThreadId);

    const grown = parseClaudeTranscript(longChat(112), { allMessages: true });
    expect(
      yield* importer.appendImportedMessages({
        threadId: rewindThreadId,
        thread: grown,
        source: rewindSource,
      }),
    ).toBe(4);
    expect(
      yield* importer.appendImportedMessages({
        threadId: rewindThreadId,
        thread: grown,
        source: rewindSource,
      }),
    ).toBe(0);

    const after = yield* store.getThreadRecords(rewindThreadId, ["messages"]);
    expect(after.messages.map((message) => message.text)).toEqual([
      ...imported.messages.map((message) => message.text),
      "Prompt 111",
      "Reply 111",
      "Prompt 112",
      "Reply 112",
    ]);
    const points = yield* rewindPoints(rewindThreadId);
    expect(points.slice(0, -2)).toEqual(before);
    expect(points.slice(-2)).toEqual([
      {
        prompt: "Prompt 111",
        resumeAfter: "reply-110",
        restoreFilesBy: "prompt-111",
        hiddenWithIt: ["Prompt 111", "Reply 111"],
      },
      {
        prompt: "Prompt 112",
        resumeAfter: "reply-111",
        restoreFilesBy: "prompt-112",
        hiddenWithIt: ["Prompt 112", "Reply 112"],
      },
    ]);
  }).pipe(Effect.provide(storeBackedImporter())),
);

it.effect("leaves a message it cannot place for certain without a rewind point", () => {
  // The desktop app wrote the second prompt twice, same text and time, two uuids.
  const lines = longChat(3).split("\n");
  const second = lines.findIndex((line) => line.includes('"uuid":"prompt-2"'));
  const contents = [
    ...lines.slice(0, second + 1),
    lines[second]!.replace('"uuid":"prompt-2"', '"uuid":"prompt-2-copy"'),
    ...lines.slice(second + 1),
  ].join("\n");
  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const heal = yield* ImportedRewindHeal.ImportedRewindHeal;
    yield* importer.importThread({
      projectId,
      workspaceRoot: "/workspace/project",
      threadId: rewindThreadId,
      thread: withoutRewindPoints(parseClaudeTranscript(contents)),
      source: rewindSource,
    });

    expect(yield* heal.run()).toBe(1);
    expect(yield* rewindPoints(rewindThreadId)).toEqual([
      {
        prompt: "Prompt 1",
        resumeAfter: null,
        restoreFilesBy: "prompt-1",
        // Claude's session holds both copies after the first turn, so they go with it.
        hiddenWithIt: ["Prompt 1", "Reply 1", "Prompt 2", "Prompt 2", "Reply 2"],
      },
      { prompt: "Prompt 2", rewind: "none" },
      { prompt: "Prompt 2", rewind: "none" },
      {
        prompt: "Prompt 3",
        resumeAfter: "reply-2",
        restoreFilesBy: "prompt-3",
        hiddenWithIt: ["Prompt 3", "Reply 3"],
      },
    ]);
  }).pipe(
    Effect.provide(
      storeBackedImporter({
        runtimes: { list: () => Effect.succeed([importRow] as never) },
        scanner: transcriptReader(contents),
      }),
    ),
  );
});

it.effect("heals the imported part of a chat that already ran turns in T3 Code", () => {
  const desktop = [
    { prompt: "Prompt 1", reply: "Reply 1" },
    { prompt: "Prompt 2", reply: "Reply 2" },
  ];
  // T3 Code continued the session, so its turn follows in the same transcript.
  const transcript = claudeTranscript([
    ...desktop,
    { prompt: "Tighten the wording", reply: "Tightened." },
  ]);
  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const heal = yield* ImportedRewindHeal.ImportedRewindHeal;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    yield* importer.importThread({
      projectId,
      workspaceRoot: "/workspace/project",
      threadId: rewindThreadId,
      thread: withoutRewindPoints(parseClaudeTranscript(claudeTranscript(desktop))),
      source: rewindSource,
    });
    const [providerThread] = (yield* store.getThreadRecords(rewindThreadId, ["providerThreads"]))
      .providerThreads;
    for (const event of claudeTurnRunInT3Code({
      providerThread: providerThread!,
      ordinal: 1,
      providerTurnOrdinal: 1,
      prompt: "Tighten the wording",
      reply: "Tightened.",
      nativeReplyId: "reply-3",
      at: "2026-09-02T09:00:00.000Z",
    })) {
      yield* store.apply(event);
    }
    const t3CodeRecords = (records: { readonly runs: ReadonlyArray<OrchestrationV2Run> }) =>
      records.runs.filter((run) => run.ordinal === 1);
    const before = yield* store.getThreadRecords(rewindThreadId, ["runs", "providerTurns"]);
    expect(yield* importer.isUntouchedImport(rewindThreadId)).toBe(false);

    expect(yield* heal.run()).toBe(1);
    expect(yield* rewindPoints(rewindThreadId)).toEqual([
      {
        prompt: "Prompt 1",
        resumeAfter: null,
        restoreFilesBy: "prompt-1",
        hiddenWithIt: ["Prompt 1", "Reply 1"],
      },
      {
        prompt: "Prompt 2",
        resumeAfter: "reply-1",
        restoreFilesBy: "prompt-2",
        hiddenWithIt: ["Prompt 2", "Reply 2"],
      },
      {
        // T3 Code's own turn now resumes after the imported part, not at the thread start.
        prompt: "Tighten the wording",
        resumeAfter: "reply-2",
        restoreFilesBy: "missing",
        hiddenWithIt: ["Tighten the wording", "Tightened."],
      },
    ]);
    const after = yield* store.getThreadRecords(rewindThreadId, ["runs", "providerTurns"]);
    expect(t3CodeRecords(after)).toEqual(t3CodeRecords(before));
    expect(after.providerTurns.filter((turn) => turn.id === before.providerTurns[0]?.id)).toEqual(
      before.providerTurns,
    );
    expect(after.runs.map((run) => run.ordinal).toSorted()).toEqual([1, 2, 3]);

    const healed = yield* store.getThreadRecords(rewindThreadId, ["runs", "messages"]);
    expect(yield* heal.run()).toBe(0);
    expect(yield* store.getThreadRecords(rewindThreadId, ["runs", "messages"])).toEqual(healed);
  }).pipe(
    Effect.provide(
      storeBackedImporter({
        runtimes: { list: () => Effect.succeed([importRow] as never) },
        scanner: transcriptReader(transcript),
      }),
    ),
  );
});

it.effect("leaves a chat that ran turns in T3 Code alone when its transcript hides where", () => {
  const desktop = [{ prompt: "Prompt 1", reply: "Reply 1" }];
  // Prompts follow the imported part, but none is the one T3 Code sent.
  const transcript = claudeTranscript([...desktop, { prompt: "Something else", reply: "Done." }]);
  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const heal = yield* ImportedRewindHeal.ImportedRewindHeal;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    yield* importer.importThread({
      projectId,
      workspaceRoot: "/workspace/project",
      threadId: rewindThreadId,
      thread: withoutRewindPoints(parseClaudeTranscript(claudeTranscript(desktop))),
      source: rewindSource,
    });
    const [providerThread] = (yield* store.getThreadRecords(rewindThreadId, ["providerThreads"]))
      .providerThreads;
    for (const event of claudeTurnRunInT3Code({
      providerThread: providerThread!,
      ordinal: 1,
      providerTurnOrdinal: 1,
      prompt: "Tighten the wording",
      reply: "Tightened.",
      nativeReplyId: "reply-in-another-file",
      at: "2026-09-02T09:00:00.000Z",
    })) {
      yield* store.apply(event);
    }

    expect(yield* heal.run()).toBe(0);
    expect((yield* rewindPoints(rewindThreadId))[0]).toEqual({
      prompt: "Prompt 1",
      rewind: "none",
    });
  }).pipe(
    Effect.provide(
      storeBackedImporter({
        runtimes: { list: () => Effect.succeed([importRow] as never) },
        scanner: transcriptReader(transcript),
      }),
    ),
  );
});
