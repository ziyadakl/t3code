import { assert, it } from "@effect/vitest";
import {
  MessageId,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "./ProjectionStore.ts";
import type {
  ProviderAdapterV2RewindFilesInput,
  ProviderAdapterV2RewindFilesResult,
} from "./ProviderAdapter.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ThreadCodeRewindService from "./ThreadCodeRewindService.ts";

const threadId = ThreadId.make("thread:code-rewind");
const providerThreadId = ProviderThreadId.make("provider-thread:code-rewind");
const providerSessionId = ProviderSessionId.make("provider-session:code-rewind");
const providerInstanceId = ProviderInstanceId.make("claudeAgent");
const firstMessageId = MessageId.make("message:code-rewind:1");
const secondMessageId = MessageId.make("message:code-rewind:2");

// Two sent messages. Claude recorded its uuid only for the second turn, as
// for a thread whose first turn ran before file checkpoints were on.
const projection = {
  thread: {
    id: threadId,
    activeProviderThreadId: providerThreadId,
    modelSelection: { instanceId: providerInstanceId, model: "claude-test" },
  },
  providerThreads: [
    {
      id: providerThreadId,
      providerSessionId,
      providerInstanceId,
      nativeThreadRef: { driver: "claudeAgent", nativeId: "native-session", strength: "strong" },
    },
  ],
  providerSessions: [],
  runs: [
    { id: RunId.make("run:1"), ordinal: 1, userMessageId: firstMessageId, status: "completed" },
    { id: RunId.make("run:2"), ordinal: 2, userMessageId: secondMessageId, status: "completed" },
  ],
  attempts: [
    { id: RunAttemptId.make("attempt:1"), runId: RunId.make("run:1") },
    { id: RunAttemptId.make("attempt:2"), runId: RunId.make("run:2") },
  ],
  providerTurns: [
    { id: "provider-turn:1", providerThreadId, runAttemptId: "attempt:1", ordinal: 1 },
    {
      id: "provider-turn:2",
      providerThreadId,
      runAttemptId: "attempt:2",
      ordinal: 2,
      nativeUserMessageId: "claude-user-uuid-2",
    },
  ],
} as unknown as OrchestrationV2ThreadProjection;

/** Claude's answers, keyed by dry run, and the restores it was asked for. */
const makeLayer = (answers: {
  readonly dryRun: ProviderAdapterV2RewindFilesResult;
  readonly restore: ProviderAdapterV2RewindFilesResult;
}) => {
  const requests: Array<Pick<ProviderAdapterV2RewindFilesInput, "nativeUserMessageId" | "dryRun">> =
    [];
  const layer = ThreadCodeRewindService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
        }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () =>
            Effect.succeed({ runtimeMode: "full-access", interactionMode: "default", cwd: "/w" }),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open: () =>
            Effect.succeed({
              rewindFiles: (input: ProviderAdapterV2RewindFilesInput) =>
                Effect.sync(() => {
                  requests.push({
                    nativeUserMessageId: input.nativeUserMessageId,
                    dryRun: input.dryRun,
                  });
                  return input.dryRun ? answers.dryRun : answers.restore;
                }),
            } as never),
        }),
      ),
    ),
  );
  return { layer, requests };
};

const unchanged: ProviderAdapterV2RewindFilesResult = {
  canRewind: true,
  filesChanged: [],
  insertions: 0,
  deletions: 0,
  skippedLinks: 0,
};

it.effect("previews the files Claude changed since a sent message", () => {
  const { layer, requests } = makeLayer({
    dryRun: { ...unchanged, filesChanged: ["/w/notes.md", "/w/app.ts"], insertions: 3 },
    restore: unchanged,
  });
  return Effect.gen(function* () {
    const service = yield* ThreadCodeRewindService.ThreadCodeRewindServiceV2;
    const preview = yield* service.preview({ threadId, messageId: secondMessageId });

    assert.deepEqual(preview, {
      filesChanged: ["/w/notes.md", "/w/app.ts"],
      insertions: 3,
      deletions: 0,
    });
    assert.deepEqual(requests, [{ nativeUserMessageId: "claude-user-uuid-2", dryRun: true }]);
  }).pipe(Effect.provide(layer));
});

it.effect("offers no code restore for a message Claude kept no file snapshot for", () => {
  const { layer, requests } = makeLayer({ dryRun: unchanged, restore: unchanged });
  return Effect.gen(function* () {
    const service = yield* ThreadCodeRewindService.ThreadCodeRewindServiceV2;
    const preview = yield* service.preview({ threadId, messageId: firstMessageId });

    assert.deepEqual(preview, {
      filesChanged: [],
      insertions: 0,
      deletions: 0,
      unavailableReason: "Claude kept no file snapshots for this message.",
    });
    assert.deepEqual(requests, []);
  }).pipe(Effect.provide(layer));
});

it.effect("passes on Claude's reason when it cannot restore a message", () => {
  const { layer } = makeLayer({
    dryRun: { ...unchanged, canRewind: false, error: "No file checkpoint found for this message." },
    restore: {
      ...unchanged,
      canRewind: false,
      error: "No file checkpoint found for this message.",
    },
  });
  return Effect.gen(function* () {
    const service = yield* ThreadCodeRewindService.ThreadCodeRewindServiceV2;
    const preview = yield* service.preview({ threadId, messageId: secondMessageId });
    const restored = yield* service.restore({ threadId, runId: RunId.make("run:2") });

    assert.equal(preview.unavailableReason, "No file checkpoint found for this message.");
    assert.deepEqual(preview.filesChanged, []);
    assert.deepEqual(restored, {
      restored: false,
      reason: "Could not restore code: No file checkpoint found for this message.",
    });
  }).pipe(Effect.provide(layer));
});

it.effect("reports files a restore left alone", () => {
  const { layer, requests } = makeLayer({
    dryRun: unchanged,
    restore: { ...unchanged, skippedLinks: 2 },
  });
  return Effect.gen(function* () {
    const service = yield* ThreadCodeRewindService.ThreadCodeRewindServiceV2;
    const result = yield* service.restore({ threadId, runId: RunId.make("run:2") });

    assert.deepEqual(result, { restored: true, skippedLinks: 2 });
    assert.equal(
      ThreadCodeRewindService.skippedFilesMessage(2),
      "Code restored, but 2 files were left as they are: a link made them unsafe to write.",
    );
    assert.deepEqual(requests, [{ nativeUserMessageId: "claude-user-uuid-2", dryRun: false }]);
  }).pipe(Effect.provide(layer));
});
