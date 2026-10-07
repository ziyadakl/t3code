import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("agent-session-import-project");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerSessionId = "native-codex-thread";
const threadId = ThreadId.make(`import:${providerInstanceId}:${providerSessionId}`);

it.effect("imports messages once and preserves the provider native resume binding", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const upserts: Array<unknown> = [];
  const recorded: Array<unknown> = [];
  let imported = false;
  const scanner = AgentSessionScanner.AgentSessionScanner.of({
    scan: Effect.die("unused"),
    providerHomes: () => Effect.die("unused"),
    readThread: () => Effect.die("unused"),
    recentThreads: () =>
      Stream.succeed({
        _tag: "Importable",
        source: {
          provider: "codex",
          providerInstanceId,
          providerSessionId,
          filePath: "/tmp/native-codex-thread.jsonl",
          size: 100,
          mtimeMs: 2,
          device: 3,
          inode: 4,
          birthtimeMs: 1,
        },
        thread: {
          source: "codex",
          providerInstanceId,
          providerSessionId,
          title: "Imported thread",
          model: "gpt-5.4",
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-01T10:01:00.000Z",
          messages: [
            { role: "user", text: "Fix it", createdAt: "2026-09-01T10:00:00.000Z" },
            { role: "assistant", text: "Fixed", createdAt: "2026-09-01T10:01:00.000Z" },
          ],
        },
      }),
  });
  const layerTest = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
            ),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            imported
              ? Effect.succeed({
                  thread: { id: threadId, projectId, historyOrigin: "v1_import" },
                } as never)
              : Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            Effect.sync(() => {
              writes.push(input.events);
              imported = true;
              return [];
            }),
        }),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () => Effect.succeed([]),
          upsert: (input) => Effect.sync(() => void upserts.push(input)),
          recordImportedTranscript: (input) => Effect.sync(() => void recorded.push(input)),
        }),
        IdAllocator.layer,
      ),
    ),
  );

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.map((event) => event.type)).toEqual([
      "thread.created",
      "message.updated",
      "turn-item.updated",
      "message.updated",
      "turn-item.updated",
      "provider-thread.updated",
    ]);
    const created = writes[0]?.find((event) => event.type === "thread.created");
    const providerThread = writes[0]?.find((event) => event.type === "provider-thread.updated");
    expect(created?.payload).toMatchObject({
      id: threadId,
      activeProviderThreadId: providerThread?.payload.id,
      historyOrigin: "v1_import",
    });
    expect(providerThread?.payload).toMatchObject({
      appThreadId: threadId,
      nativeThreadRef: {
        driver: "codex",
        nativeId: providerSessionId,
        strength: "strong",
      },
    });
    expect(
      writes[0]
        ?.filter((event) => event.type === "message.updated")
        .map((event) => event.payload.text),
    ).toEqual(["Fix it", "Fixed"]);
    expect(upserts).toEqual([
      expect.objectContaining({
        threadId,
        providerInstanceId,
        resumeCursor: { threadId: providerSessionId },
      }),
    ]);
    expect(recorded).toHaveLength(2);
  }).pipe(Effect.provide(layerTest));
});

it.effect(
  "imports into the active list and later appends only the messages it has not seen",
  () => {
    const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
    let runs: Array<unknown> = [];
    let messageCount = 0;
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
                    messages: Array.from({ length: messageCount }, () => ({ runId: null })),
                    providerThreads: [],
                    providerTurns: [],
                  } as never),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            write: (input) =>
              Effect.sync(() => {
                writes.push(input.events);
                messageCount += input.events.filter(
                  (event) => event.type === "message.updated",
                ).length;
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
      timestamp: `2026-09-01T10:00:${String(second++).padStart(2, "0")}.000Z`,
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

function parseClaudeTranscript(contents: string): AgentSessionScanner.AgentSessionThread {
  const thread = AgentSessionScanner.parseAgentSessionTranscript({
    source: "claudeAgent",
    providerInstanceId: claudeInstanceId,
    fallbackSessionId: rewindSessionId,
    lastActiveAtMs: Date.parse("2026-09-01T11:00:00.000Z"),
    contents,
  });
  if (thread === null) throw new Error("transcript did not parse");
  return thread;
}

/** The importer over a real projection store, as the server runs it. */
const storeBackedImporter = (input?: {
  readonly scanner?: Partial<AgentSessionScanner.AgentSessionScanner["Service"]>;
  readonly runtimes?: Partial<ProviderSessionRuntime.ProviderSessionRuntimeRepository["Service"]>;
}) => {
  const storeLayer = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
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
            Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
              upsert: () => Effect.void,
              recordImportedTranscript: () => Effect.void,
              list: () => Effect.succeed([]),
              ...input?.runtimes,
            }),
            IdAllocator.layer,
          ),
        ),
      );
    }),
  );
  return Layer.provideMerge(importerLayer, storeLayer);
};

/**
 * What a rewind to just before each prompt of an imported thread would use:
 * the Claude uuid the resumed session continues after (null: the thread start)
 * and the prompt uuid Claude restores files by.
 */
const rewindPoints = Effect.fn("rewindPoints")(function* (threadId: ThreadId) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const records = yield* store.getThreadRecords(threadId, [
    "messages",
    "runs",
    "attempts",
    "providerTurns",
  ]);
  const turnOf = (ordinal: number) => {
    const run = records.runs.find((candidate) => candidate.ordinal === ordinal);
    const attempt = records.attempts.find((candidate) => candidate.id === run?.activeAttemptId);
    return records.providerTurns.find((turn) => turn.runAttemptId === attempt?.id);
  };
  return records.messages
    .filter((message) => message.role === "user")
    .map((message) => {
      const run = records.runs.find((candidate) => candidate.userMessageId === message.id);
      if (run === undefined) return { prompt: message.text, rewind: "none" as const };
      return {
        prompt: message.text,
        resumeAfter:
          run.ordinal === 1
            ? null
            : (turnOf(run.ordinal - 1)?.nativeTurnRef?.nativeId ?? "missing"),
        restoreFilesBy: turnOf(run.ordinal)?.nativeUserMessageId ?? "missing",
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

    expect(yield* importer.healImportedRewindPoints()).toBe(1);
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
    expect(yield* importer.healImportedRewindPoints()).toBe(0);
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
