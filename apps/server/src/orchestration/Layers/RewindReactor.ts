/**
 * RewindReactor (ADR-0002) — non-destructive conversation rewind + decoupled
 * file-restore. See `Services/RewindReactor.ts` for the contract.
 *
 * NON-DESTRUCTIVE INVARIANT: this reactor never deletes a message or turn row.
 * The conversation rewind only flips `abandoned` (via the projection) and moves
 * the provider-session cursor; the file-restore only touches the working tree.
 */
import {
  CommandId,
  EventId,
  type MessageId,
  type ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { RewindReactor, type RewindReactorShape } from "../Services/RewindReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { WorkspaceEntries } from "../../workspace/Services/WorkspaceEntries.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

// The shared marker (WS-1 reads it) lives opaquely inside the provider session's
// `resume_cursor_json` blob. We merge into the existing blob so unknown fields
// the adapter writes (resume id, turnCount, etc.) survive the rewind write.
interface RewindCursorBlob {
  readonly resumeSessionAt?: string;
  readonly rewindPending: boolean;
  readonly [key: string]: unknown;
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const checkpointStore = yield* CheckpointStore;
  const workspaceEntries = yield* WorkspaceEntries;

  const appendFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind: "rewind.failed" | "files.restore.failed";
    readonly summary: string;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId(input.kind),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "error",
            kind: input.kind,
            summary: input.summary,
            payload: { detail: input.detail },
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
      Effect.catch(() => Effect.void),
    );

  // Resolve the rewind anchor: from the target prompt's `messageId`, find the
  // provider uuid of the assistant message immediately BEFORE that prompt, so
  // the next turn resumes "up to and including" it and the prompt itself stays
  // re-askable. Reads the UNFILTERED projection (a re-rewind may target rows
  // already marked abandoned by a prior rewind).
  const resolveAnchorUuid = Effect.fn("resolveAnchorUuid")(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) {
    const target = yield* projectionThreadMessageRepository.getByMessageId({
      messageId: input.messageId,
    });
    if (Option.isNone(target)) {
      return undefined;
    }
    const messages = yield* projectionThreadMessageRepository.listByThreadId({
      threadId: input.threadId,
    });
    const cutAt = target.value.createdAt;
    // The assistant message with a non-null anchor uuid and the greatest
    // createdAt strictly before the target prompt.
    let anchor: string | undefined;
    let anchorCreatedAt: string | undefined;
    for (const message of messages) {
      if (message.role !== "assistant") {
        continue;
      }
      const uuid = message.providerMessageUuid ?? undefined;
      if (uuid === undefined) {
        continue;
      }
      if (message.createdAt >= cutAt) {
        continue;
      }
      if (anchorCreatedAt === undefined || message.createdAt > anchorCreatedAt) {
        anchorCreatedAt = message.createdAt;
        anchor = uuid;
      }
    }
    return anchor;
  });

  // Write the rewind marker into the provider session cursor blob, preserving
  // the adapter's unknown fields. WS-1's adapter reads `rewindPending` to pass
  // `resumeSessionAt` into the next query and to skip auto-advancing the cursor.
  //
  // `resumeSessionAt` is OWNED by the rewind, not an unknown field to preserve:
  // the adapter auto-advances it to the latest (forward) assistant uuid on every
  // continue, so we MUST strip the old value first and re-set it only to our
  // anchor. Leaving the forward value in place with rewindPending=true would make
  // WS-1 resume to the wrong point — a no-op rewind. When the anchor is undefined
  // (rewind to the first prompt, or a preceding row with no persisted uuid), we
  // drop `resumeSessionAt` entirely so the adapter resumes from the session start.
  const setRewindCursor = Effect.fn("setRewindCursor")(function* (input: {
    readonly threadId: ThreadId;
    readonly anchorUuid: string | undefined;
  }) {
    const binding = yield* providerSessionDirectory.getBinding(input.threadId);
    if (Option.isNone(binding)) {
      yield* Effect.logWarning("rewind: no provider session binding to carry the cursor marker", {
        threadId: input.threadId,
      });
      return;
    }
    const existingCursor =
      binding.value.resumeCursor && typeof binding.value.resumeCursor === "object"
        ? (binding.value.resumeCursor as Record<string, unknown>)
        : {};
    // Strip the adapter's forward `resumeSessionAt`; we re-set it only to the
    // rewind anchor below.
    const { resumeSessionAt: _staleResumeSessionAt, ...preservedCursor } = existingCursor;
    const nextCursor: RewindCursorBlob = {
      ...preservedCursor,
      ...(input.anchorUuid !== undefined ? { resumeSessionAt: input.anchorUuid } : {}),
      rewindPending: true,
    };
    yield* providerSessionDirectory.upsert({
      threadId: binding.value.threadId,
      provider: binding.value.provider,
      ...(binding.value.providerInstanceId !== undefined
        ? { providerInstanceId: binding.value.providerInstanceId }
        : {}),
      resumeCursor: nextCursor,
    });
  });

  const handleRewindRequested = Effect.fn("handleRewindRequested")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.conversation-rewind-requested" }>,
  ) {
    const now = yield* nowIso;
    const threadId = event.payload.threadId;
    const messageId = event.payload.messageId;

    // 1. Resolve the pre-prompt anchor uuid from the projection.
    const anchorUuid = yield* resolveAnchorUuid({ threadId, messageId });

    // 2. Set the provider-session cursor: resumeSessionAt = anchor, rewindPending.
    yield* setRewindCursor({ threadId, anchorUuid });

    // 2b. STOP the provider session (full stop → status "stopped"), so the next
    // prompt cold-starts through `ProviderService.startSession` and consumes the
    // marker via the adapter's `readClaudeResumeState` (Path B). The web rewind
    // flow never stops the session itself; without this, the still-LIVE session
    // is reused (ProviderCommandReactor reuse check at :456-457) and the marker
    // is ignored — and the first live `sendTurn` auto-advances the in-memory
    // cursor, clobbering the persisted anchor.
    //
    // A direct `providerService.stopSession` (not a restart-in-place) is required:
    //   - `listSessions()` derives `activeSession` from the adapters' LIVE
    //     in-memory sessions; the Claude adapter's stop deletes the session from
    //     its map (ClaudeAdapter.ts:2566) so it drops out of `listSessions()` →
    //     `activeSession` becomes undefined → the reuse check yields null → cold
    //     start. A restart-in-place would instead pass the marker-less in-memory
    //     `activeSession.resumeCursor` (ProviderCommandReactor.ts:486-488).
    //   - The stop's directory upsert OMITS `resumeCursor` (ProviderService.ts:
    //     830-838) and `ProviderSessionDirectory.upsert` preserves the existing
    //     blob when the field is absent (ProviderSessionDirectory.ts:140-143), so
    //     the marker survives stop → cold-start. The durable `resume` id in that
    //     blob carries forward, so the cold-start is a CONTINUATION of the same
    //     Claude session, not a new one.
    //   - The adapter's idle stop does NOT auto-advance the cursor: it only runs
    //     `completeTurn` (which calls `updateResumeCursor`) when a turn is in
    //     flight (ClaudeAdapter.ts:2515-2517), and the rewind flow is idle.
    //
    // Guard on a live session (mirrors ProviderCommandReactor.ts:925) so a missing
    // session is a clean no-op, not a spurious "rewind failed": `stopSession`
    // resolves with `allowRecovery: false` and would error otherwise, aborting the
    // handler before the abandoned event is emitted.
    const liveSessions = yield* providerService.listSessions();
    const hasLiveSession = liveSessions.some((entry) => entry.threadId === threadId);
    if (hasLiveSession) {
      yield* providerService.stopSession({ threadId });
    }

    // Count the turns that will be marked abandoned (those requested at/after the
    // target prompt). The projection applies the actual flip on the emitted
    // event; we report the same cut here for the event payload.
    const turns = yield* projectionTurnRepository.listByThreadId({ threadId });
    const target = yield* projectionThreadMessageRepository.getByMessageId({ messageId });
    const cutAt = Option.match(target, {
      onNone: () => undefined,
      onSome: (message) => message.createdAt,
    });
    const turnCount =
      cutAt === undefined
        ? 0
        : turns.filter((turn) => turn.turnId !== null && turn.requestedAt >= cutAt).length;

    // 3 + 4. Dispatch the bridge command; the decider emits
    // `thread.conversation-rewound`, which the ProjectionPipeline applies as a
    // non-destructive "mark abandoned" on forward messages/turns. No checkpoint
    // is captured or restored — the working tree is untouched.
    yield* orchestrationEngine.dispatch({
      type: "thread.conversation-rewind.complete",
      commandId: yield* serverCommandId("conversation-rewind-complete"),
      threadId,
      messageId,
      ...(anchorUuid !== undefined ? { anchorProviderMessageUuid: anchorUuid } : {}),
      turnCount,
      createdAt: now,
    });
  });

  // Decoupled file-restore (ADR-0002): restore the working tree to turn N via
  // CheckpointStore.restoreCheckpoint ONLY. Reuses the restore phase of
  // CheckpointReactor.handleRevertRequested WITHOUT the provider rollback, stale
  // checkpoint deletion, or `thread.revert.complete` → row-deletion tail.
  const handleFilesRestoreRequested = Effect.fn("handleFilesRestoreRequested")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.files-restore-requested" }>,
  ) {
    const now = yield* nowIso;
    const threadId = event.payload.threadId;
    const turnCount = event.payload.turnCount;

    const sessions = yield* providerService.listSessions();
    const session = sessions.find((entry) => entry.threadId === threadId);
    if (!session?.cwd) {
      yield* appendFailureActivity({
        threadId,
        kind: "files.restore.failed",
        summary: "File restore failed",
        detail: "No active provider session with workspace cwd is bound to this thread.",
        createdAt: now,
      });
      return;
    }
    if (!isGitRepository(session.cwd)) {
      yield* appendFailureActivity({
        threadId,
        kind: "files.restore.failed",
        summary: "File restore failed",
        detail: "Checkpoints are unavailable because this project is not a git repository.",
        createdAt: now,
      });
      return;
    }

    const thread = yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!thread) {
      yield* appendFailureActivity({
        threadId,
        kind: "files.restore.failed",
        summary: "File restore failed",
        detail: "Thread was not found in read model.",
        createdAt: now,
      });
      return;
    }

    const targetCheckpointRef =
      turnCount === 0
        ? checkpointRefForThreadTurn(threadId, 0)
        : thread.checkpoints.find((checkpoint) => checkpoint.checkpointTurnCount === turnCount)
            ?.checkpointRef;
    if (!targetCheckpointRef) {
      yield* appendFailureActivity({
        threadId,
        kind: "files.restore.failed",
        summary: "File restore failed",
        detail: `Checkpoint ref for turn ${turnCount} is unavailable in read model.`,
        createdAt: now,
      });
      return;
    }

    const restored = yield* checkpointStore.restoreCheckpoint({
      cwd: session.cwd,
      checkpointRef: targetCheckpointRef,
      fallbackToHead: turnCount === 0,
    });
    if (!restored) {
      yield* appendFailureActivity({
        threadId,
        kind: "files.restore.failed",
        summary: "File restore failed",
        detail: `Filesystem checkpoint is unavailable for turn ${turnCount}.`,
        createdAt: now,
      });
      return;
    }

    // Invalidate the workspace entry cache so the @-mention file picker reflects
    // the restored filesystem state.
    yield* workspaceEntries.invalidate(session.cwd);
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (event: OrchestrationEvent) {
    if (event.type === "thread.conversation-rewind-requested") {
      yield* handleRewindRequested(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendFailureActivity({
              threadId: event.payload.threadId,
              kind: "rewind.failed",
              summary: "Conversation rewind failed",
              detail: error.message,
              createdAt,
            }),
          ),
        ),
      );
      return;
    }

    if (event.type === "thread.files-restore-requested") {
      yield* handleFilesRestoreRequested(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendFailureActivity({
              threadId: event.payload.threadId,
              kind: "files.restore.failed",
              summary: "File restore failed",
              detail: error.message,
              createdAt,
            }),
          ),
        ),
      );
      return;
    }
  });

  const processInputSafely = (event: OrchestrationEvent) =>
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("rewind reactor failed to process input", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: RewindReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.conversation-rewind-requested" &&
          event.type !== "thread.files-restore-requested"
        ) {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies RewindReactorShape;
});

export const RewindReactorLive = Layer.effect(RewindReactor, make);
