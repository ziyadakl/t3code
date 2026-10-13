import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type ServerSettings as ContractServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as ServerActivation from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadArchiveService from "./ThreadArchiveService.ts";

const NOW_MS = Date.parse("2026-10-13T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

function candidate(
  id: string,
  overrides: Partial<ProjectionStore.ProjectionAutoArchiveCandidate> = {},
): ProjectionStore.ProjectionAutoArchiveCandidate {
  return {
    id: ThreadId.make(id),
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    settledOverride: "settled",
    settledAt: at(-10 * DAY_MS),
    updatedAt: at(-10 * DAY_MS),
    pinnedAt: null,
    snoozedUntil: null,
    orphaned: false,
    busy: false,
    ...overrides,
  };
}

describe("resolveAutoArchiveReason", () => {
  const resolve = (
    thread: ProjectionStore.ProjectionAutoArchiveCandidate,
    afterDays: number | null = 7,
  ) => ThreadArchiveService.resolveAutoArchiveReason(thread, NOW_MS, afterDays);

  it("archives a thread settled and untouched for the threshold", () => {
    expect(resolve(candidate("old"))).toBe("settled");
    expect(resolve(candidate("old"), 14)).toBeNull();
    expect(resolve(candidate("old"), null)).toBeNull();
    expect(
      resolve(candidate("recent", { settledAt: at(-2 * DAY_MS), updatedAt: at(-2 * DAY_MS) })),
    ).toBeNull();
    expect(resolve(candidate("active", { settledOverride: "active", settledAt: null }))).toBeNull();
  });

  it("restarts the clock when a settled thread changes, such as an unarchive", () => {
    expect(resolve(candidate("unarchived", { updatedAt: at(-60 * 1_000) }))).toBeNull();
  });

  it("skips pinned, snoozed, and busy threads", () => {
    expect(resolve(candidate("pinned", { pinnedAt: at(-DAY_MS) }))).toBeNull();
    expect(resolve(candidate("snoozed", { snoozedUntil: at(DAY_MS) }))).toBeNull();
    expect(resolve(candidate("woke", { snoozedUntil: at(-DAY_MS) }))).toBe("settled");
    expect(resolve(candidate("busy", { busy: true }))).toBeNull();
    expect(resolve(candidate("busy-orphan", { busy: true, orphaned: true }))).toBeNull();
  });

  it("archives orphaned subagent children even with the threshold off", () => {
    const orphan = candidate("orphan", {
      orphaned: true,
      settledOverride: null,
      settledAt: null,
      updatedAt: at(-60 * 1_000),
    });
    expect(resolve(orphan)).toBe("orphaned");
    expect(resolve(orphan, null)).toBe("orphaned");
  });
});

type ArchiveCommand = Extract<
  OrchestrationV2Command,
  { readonly type: "thread.archive" | "thread.unarchive" }
>;

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data),
});

interface HarnessOptions {
  readonly candidates?: ReadonlyArray<ProjectionStore.ProjectionAutoArchiveCandidate>;
  readonly children?: Readonly<
    Record<string, ReadonlyArray<Pick<OrchestrationV2AppThread, "id" | "archivedAt">>>
  >;
  readonly settings?: ContractServerSettings;
}

const makeHarness = Effect.fn("makeThreadArchiveHarness")(function* (options: HarnessOptions) {
  const activation = yield* Deferred.make<void>();
  const settings = yield* Ref.make(options.settings ?? DEFAULT_SERVER_SETTINGS);
  const settingsChanges = yield* PubSub.unbounded<ContractServerSettings>();
  const domainEvents = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
  const commands = yield* Ref.make<ReadonlyArray<ArchiveCommand>>([]);
  const sweeps = yield* Queue.unbounded<void>();
  const childReads = yield* Queue.unbounded<ThreadId>();

  const updateSettings = (patch: ServerSettingsPatch) =>
    Effect.gen(function* () {
      const next = applyServerSettingsPatch(yield* Ref.get(settings), patch);
      yield* Ref.set(settings, next);
      yield* PubSub.publish(settingsChanges, next);
      return next;
    });

  const dispatch: Orchestrator.OrchestratorV2Shape["dispatch"] = (command) =>
    command.type === "thread.archive" || command.type === "thread.unarchive"
      ? Ref.update(commands, (recorded) => [...recorded, command]).pipe(
          Effect.as({ sequence: 1, storedEvents: [] }),
        )
      : Effect.die(new Error(`Unexpected command: ${command.type}`));

  const layerDependencies = Layer.mergeAll(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getAutoArchiveCandidates: () =>
        Queue.offer(sweeps, undefined).pipe(Effect.as(options.candidates ?? [])),
      getSubagentChildren: (threadId) =>
        Queue.offer(childReads, threadId).pipe(Effect.as(options.children?.[threadId] ?? [])),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      streamDomainEvents: Stream.fromPubSub(domainEvents),
      dispatch,
    }),
    Layer.succeed(
      ServerSettings.ServerSettingsService,
      ServerSettings.ServerSettingsService.of({
        start: Effect.void,
        ready: Effect.void,
        getSettings: Ref.get(settings),
        updateSettings,
        updateProviderInstance: () => Effect.die("Unexpected provider mutation"),
        withSettingsSnapshot: (use) => Ref.get(settings).pipe(Effect.flatMap(use)),
        streamChanges: Stream.fromPubSub(settingsChanges),
        subscribeChanges: PubSub.subscribe(settingsChanges).pipe(
          Effect.map((subscription) => Stream.fromSubscription(subscription)),
        ),
      }),
    ),
    Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );

  const start = Effect.gen(function* () {
    const service = yield* ThreadArchiveService.ThreadArchiveServiceV2;
    yield* service.start();
    yield* Deferred.succeed(activation, undefined);
    yield* Queue.take(sweeps);
    yield* service.drain;
    return service;
  });

  // Waits for the worker to pick up the event, then for its dispatches.
  const cascade = (event: OrchestrationV2DomainEvent) =>
    Effect.gen(function* () {
      const service = yield* ThreadArchiveService.ThreadArchiveServiceV2;
      yield* PubSub.publish(domainEvents, event);
      yield* Queue.take(childReads);
      yield* service.drain;
    });

  return {
    commands,
    start,
    sweeps,
    updateSettings,
    cascade,
    layer: ThreadArchiveService.layer.pipe(Layer.provide(layerDependencies)),
  };
});

function threadEvent(
  type: "thread.archived" | "thread.unarchived" | "thread.deleted",
  threadId: ThreadId,
): OrchestrationV2DomainEvent {
  const now = at(0);
  const providerInstanceId = ProviderInstanceId.make("codex");
  return {
    id: EventId.make(`event:${type}:${threadId}`),
    type,
    threadId,
    providerInstanceId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Parent",
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: type === "thread.unarchived" ? null : now,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: type === "thread.deleted" ? now : null,
    },
  };
}

const summarize = (commands: ReadonlyArray<ArchiveCommand>) =>
  commands.map((command) => [command.type, command.threadId]);

describe("ThreadArchiveServiceV2 worker", () => {
  it.effect("archives long-settled threads and orphaned children on start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* makeHarness({
          candidates: [
            candidate("old-settled"),
            candidate("recent-settled", { settledAt: at(-DAY_MS), updatedAt: at(-DAY_MS) }),
            candidate("pinned", { pinnedAt: at(-DAY_MS) }),
            candidate("orphan", { orphaned: true, settledOverride: null, settledAt: null }),
          ],
        });
        yield* Effect.gen(function* () {
          yield* fixture.start;
          expect(summarize(yield* Ref.get(fixture.commands))).toEqual([
            ["thread.archive", "old-settled"],
            ["thread.archive", "orphan"],
          ]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("sweeps again when the threshold changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* makeHarness({
          candidates: [candidate("settled-ten-days")],
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoArchiveSettledAfterDays: null },
        });
        yield* Effect.gen(function* () {
          const service = yield* fixture.start;
          expect(yield* Ref.get(fixture.commands)).toEqual([]);
          yield* fixture.updateSettings({ sidebarAutoArchiveSettledAfterDays: 7 });
          yield* Queue.take(fixture.sweeps);
          yield* service.drain;
          expect(summarize(yield* Ref.get(fixture.commands))).toEqual([
            ["thread.archive", "settled-ten-days"],
          ]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("archives and unarchives a thread's subagent children with it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const parent = ThreadId.make("parent");
        const fixture = yield* makeHarness({
          children: {
            parent: [
              { id: ThreadId.make("child-open"), archivedAt: null },
              { id: ThreadId.make("child-archived"), archivedAt: at(-DAY_MS) },
            ],
          },
        });
        yield* Effect.gen(function* () {
          yield* fixture.start;
          yield* fixture.cascade(threadEvent("thread.archived", parent));
          expect(summarize(yield* Ref.get(fixture.commands))).toEqual([
            ["thread.archive", "child-open"],
          ]);

          yield* Ref.set(fixture.commands, []);
          yield* fixture.cascade(threadEvent("thread.unarchived", parent));
          expect(summarize(yield* Ref.get(fixture.commands))).toEqual([
            ["thread.unarchive", "child-archived"],
          ]);

          yield* Ref.set(fixture.commands, []);
          yield* fixture.cascade(threadEvent("thread.deleted", parent));
          expect(summarize(yield* Ref.get(fixture.commands))).toEqual([
            ["thread.archive", "child-open"],
          ]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
});
