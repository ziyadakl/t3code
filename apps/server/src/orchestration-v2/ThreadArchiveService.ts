import { CommandId, type OrchestrationV2DomainEvent, type ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;
/** How long an orphaned subagent child stays after its last change, such as an unarchive. */
const ORPHAN_GRACE_MS = DAY_MS;

/**
 * Why the sweep archives a thread, or null to keep it. A settled thread is
 * archived once it has been settled, and untouched, for `archiveSettledAfterDays`
 * (null turns that off). A subagent child whose parent is archived, deleted or
 * missing is archived once it has been untouched for a day, whatever the
 * setting: it is the backlog of the parent cascade, and the day lets a user
 * unarchive one to read it. Pinned, snoozed, running and blocked threads are
 * never archived by the sweep, nor (filtered out by the candidate query) a
 * thread an enabled scheduled task posts into.
 */
export function resolveAutoArchiveReason(
  thread: ProjectionStore.ProjectionAutoArchiveCandidate,
  nowMs: number,
  archiveSettledAfterDays: number | null,
): "settled" | "orphaned" | null {
  if (thread.busy || thread.pinnedAt !== null) return null;
  if (thread.snoozedUntil !== null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs) {
    return null;
  }
  if (thread.orphaned) {
    return DateTime.toEpochMillis(thread.updatedAt) <= nowMs - ORPHAN_GRACE_MS ? "orphaned" : null;
  }
  if (archiveSettledAfterDays === null || thread.settledSince === null) return null;
  // Any later change (an unarchive, a rename, a mode switch) restarts the
  // clock, so a thread the user just unarchived is not archived again at once.
  const anchorMs = Math.max(
    DateTime.toEpochMillis(thread.settledSince),
    DateTime.toEpochMillis(thread.updatedAt),
  );
  return anchorMs <= nowMs - archiveSettledAfterDays * DAY_MS ? "settled" : null;
}

export class ThreadArchiveServiceV2 extends Context.Service<
  ThreadArchiveServiceV2,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadArchiveService/ThreadArchiveServiceV2") {}

type ArchiveJob =
  | { readonly type: "sweep" }
  | { readonly type: "cascade"; readonly threadId: ThreadId; readonly archive: boolean };

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventStore = yield* EventStore.EventStoreV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;

  // Archive and unarchive go through the normal commands, so provider
  // sessions detach and terminals clean up exactly as for a user's archive.
  const dispatch = Effect.fn("ThreadArchiveServiceV2.dispatch")(
    function* (type: "thread.archive" | "thread.unarchive", threadId: ThreadId, reason: string) {
      const uuid = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      yield* orchestrator.dispatch({
        type,
        commandId: CommandId.make(`server:${reason}:${threadId}:${uuid}`),
        threadId,
      });
    },
    (effect, type, threadId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("automatic thread archive skipped", {
                type,
                threadId,
                cause: Cause.pretty(cause),
              }),
        ),
      ),
  );

  const sweep = Effect.fn("ThreadArchiveServiceV2.sweep")(function* () {
    const settings = yield* settingsService.getSettings;
    const candidates = yield* projections.getAutoArchiveCandidates();
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    yield* Effect.forEach(
      candidates,
      (thread) => {
        const reason = resolveAutoArchiveReason(
          thread,
          nowMs,
          settings.sidebarAutoArchiveSettledAfterDays,
        );
        return reason === null
          ? Effect.void
          : dispatch("thread.archive", thread.id, `auto-archive-${reason}`);
      },
      { concurrency: 8, discard: true },
    );
  });

  // Each child's own archived or unarchived event cascades to its children,
  // so one level per pass reaches every descendant. A running child is never
  // archived here; the orphan sweep archives it once it is idle. Unarchiving
  // restores only the children archived at or after the parent's last archive,
  // so a child archived earlier for its own reasons stays archived.
  const cascade = Effect.fn("ThreadArchiveServiceV2.cascade")(function* (
    threadId: ThreadId,
    archive: boolean,
  ) {
    const children = yield* projections.getSubagentChildren(threadId);
    if (archive) {
      yield* Effect.forEach(
        children.filter((child) => child.archivedAt === null && !child.busy),
        (child) => dispatch("thread.archive", child.id, "archive-with-parent"),
        { concurrency: 8, discard: true },
      );
      return;
    }
    if (children.every((child) => child.archivedAt === null)) return;
    // No archive on record (an imported thread): restore nothing rather than guess.
    const lastArchive = yield* eventStore
      .read({ threadId, eventType: "thread.archived" })
      .pipe(Stream.runLast);
    if (Option.isNone(lastArchive)) return;
    const parentArchivedAt = lastArchive.value.event.occurredAt;
    yield* Effect.forEach(
      children.filter(
        (child) =>
          child.archivedAt !== null &&
          DateTime.toEpochMillis(child.archivedAt) >= DateTime.toEpochMillis(parentArchivedAt),
      ),
      (child) => dispatch("thread.unarchive", child.id, "unarchive-with-parent"),
      { concurrency: 8, discard: true },
    );
  });

  const worker = yield* makeDrainableWorker((job: ArchiveJob) =>
    Effect.gen(function* () {
      if (job.type === "sweep") return yield* sweep();
      return yield* cascade(job.threadId, job.archive);
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("automatic thread archive failed", {
              job,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  const processEvent = (event: OrchestrationV2DomainEvent) => {
    switch (event.type) {
      case "thread.archived":
      case "thread.deleted":
        return worker.enqueue({ type: "cascade", threadId: event.threadId, archive: true });
      case "thread.unarchived":
        return worker.enqueue({ type: "cascade", threadId: event.threadId, archive: false });
      default:
        return Effect.void;
    }
  };

  const start: ThreadArchiveServiceV2["Service"]["start"] = Effect.fn(
    "ThreadArchiveServiceV2.start",
  )(function* () {
    const settingsChanges = yield* settingsService.subscribeChanges;
    const events = orchestrator.streamDomainEvents;
    let lastAfterDays = (yield* settingsService.getSettings.pipe(Effect.orDie))
      .sidebarAutoArchiveSettledAfterDays;
    // Thresholds are in days, so an hourly sweep is plenty; a settings change
    // sweeps at once.
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue({ type: "sweep" });
        yield* worker.drain;
      }).pipe(Effect.repeat(Schedule.spaced("1 hour")), Effect.asVoid),
    );
    yield* forkParked(
      Stream.runForEach(settingsChanges, (settings) => {
        if (settings.sidebarAutoArchiveSettledAfterDays === lastAfterDays) return Effect.void;
        lastAfterDays = settings.sidebarAutoArchiveSettledAfterDays;
        return worker.enqueue({ type: "sweep" });
      }),
    );
    yield* forkParked(
      Stream.runForEach(events, processEvent).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Thread archive event stream failed", { cause }),
        ),
      ),
    );
  });

  return { start, drain: worker.drain } satisfies ThreadArchiveServiceV2["Service"];
});

export const layer = Layer.effect(ThreadArchiveServiceV2, make);
