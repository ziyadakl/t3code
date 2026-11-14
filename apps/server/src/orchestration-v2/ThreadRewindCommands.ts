/**
 * The three orchestrator command handlers behind Claude message rewind:
 * `thread.rewind`, the internal imported-session bind, and the internal
 * rewind-finished record. The orchestrator builds them once from its own
 * closures and routes one `case` per command here.
 */
import {
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type ProviderInstanceId,
  type ProviderSessionId,
  type ThreadId,
  threadRewindRestores,
} from "@t3tools/contracts";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import type {
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  OrchestratorProviderAdapterError,
} from "./Orchestrator.ts";
import type {
  ProjectionRecordField,
  ProjectionRecordFilter,
  ProjectionRecords,
  ProjectionStoreV2,
} from "./ProjectionStore.ts";
import type { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import {
  NO_FILE_SNAPSHOTS_MESSAGE,
  previousConversationRun,
  runFileCheckpointTurn,
} from "./ThreadRewindTargets.ts";

type ProviderSessionIdError =
  | Effect.Error<ReturnType<ProviderAdapter.ProviderAdapterV2["Service"]["getCapabilities"]>>
  | Effect.Error<ReturnType<IdAllocator.IdAllocatorV2["Service"]["allocate"]["providerSession"]>>;

type Events = Ref.Ref<Array<OrchestrationV2DomainEvent>>;
type Effects = Ref.Ref<Array<PendingOrchestrationEffectV2>>;

/**
 * An imported chat holds its native history before T3 Code opens a session
 * for it; its first turn, or a rewind, opens one.
 */
function holdsUnboundImportedSession(
  thread: Pick<OrchestrationV2AppThread, "historyOrigin">,
  providerThread: OrchestrationV2ProviderThread,
): boolean {
  return (
    providerThread.providerSessionId === null &&
    thread.historyOrigin === "v1_import" &&
    providerThread.nativeThreadRef?.nativeId != null
  );
}

/** What the orchestrator lends the rewind handlers: its closures and error classes. */
export interface ThreadRewindCommandDeps {
  readonly projectionStore: ProjectionStoreV2["Service"];
  readonly providerAdapters: ProviderAdapterRegistryV2["Service"];
  readonly mapDispatchError: (
    command: OrchestrationV2ServerCommand,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, OrchestratorDispatchError, R>;
  readonly providerSessionIdFor: (input: {
    readonly adapter: ProviderAdapter.ProviderAdapterV2["Service"];
    readonly providerInstanceId: ProviderInstanceId;
    readonly threadId: ThreadId;
  }) => Effect.Effect<ProviderSessionId, ProviderSessionIdError>;
  readonly emit: (
    events: Events,
    command: OrchestrationV2ServerCommand,
  ) => <Event extends OrchestrationV2DomainEvent>(
    event: Omit<Event, "id">,
  ) => Effect.Effect<Event, OrchestratorDispatchError>;
  readonly loadProjectionForCommand: <K extends ProjectionRecordField>(
    command: OrchestrationV2Command,
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) => Effect.Effect<ProjectionRecords<K>, OrchestratorProjectionError>;
  readonly hasLiveRun: (projection: Pick<OrchestrationV2ThreadProjection, "runs">) => boolean;
  readonly providerTurnForRun: (
    projection: Pick<OrchestrationV2ThreadProjection, "providerTurns" | "attempts">,
    run: OrchestrationV2Run,
  ) => OrchestrationV2ProviderTurn | undefined;
  /** The orchestrator's own error classes, passed in so this file never imports it at run time. */
  readonly errors: {
    readonly OrchestratorDispatchError: typeof OrchestratorDispatchError;
    readonly OrchestratorProjectionError: typeof OrchestratorProjectionError;
    readonly OrchestratorProviderAdapterError: typeof OrchestratorProviderAdapterError;
  };
}

export function makeThreadRewindCommands(deps: ThreadRewindCommandDeps) {
  const {
    projectionStore,
    providerAdapters,
    mapDispatchError,
    providerSessionIdFor,
    emit,
    loadProjectionForCommand,
    hasLiveRun,
    providerTurnForRun,
    errors: {
      OrchestratorDispatchError,
      OrchestratorProjectionError,
      OrchestratorProviderAdapterError,
    },
  } = deps;

  /** Records a new provider session for an imported chat that has none yet. */
  const bindImportedSession = Effect.fn("Orchestrator.bindImportedSession")(function* (
    command: Extract<
      OrchestrationV2ServerCommand,
      { readonly type: "thread.rewind" | "provider-thread.imported-session.bind" }
    >,
    events: Events,
    input: {
      readonly adapter: ProviderAdapter.ProviderAdapterV2["Service"];
      readonly providerThread: OrchestrationV2ProviderThread;
      readonly now: DateTime.Utc;
    },
  ) {
    const providerSessionId = yield* mapDispatchError(command)(
      providerSessionIdFor({
        adapter: input.adapter,
        providerInstanceId: input.providerThread.providerInstanceId,
        threadId: command.threadId,
      }),
    );
    yield* emit(
      events,
      command,
    )({
      type: "provider-thread.updated",
      threadId: command.threadId,
      driver: input.providerThread.driver,
      providerInstanceId: input.providerThread.providerInstanceId,
      occurredAt: input.now,
      payload: { ...input.providerThread, providerSessionId, updatedAt: input.now },
    });
  });

  const dispatchImportedSessionBind = Effect.fn("Orchestrator.dispatchImportedSessionBind")(
    function* (
      command: Extract<
        OrchestrationV2InternalCommand,
        { readonly type: "provider-thread.imported-session.bind" }
      >,
      events: Events,
    ) {
      const projection = yield* projectionStore
        .getThreadRecords(command.threadId, ["providerThreads"])
        .pipe(
          Effect.mapError(() => new OrchestratorProjectionError({ threadId: command.threadId })),
        );
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === projection.thread.activeProviderThreadId,
      );
      if (
        providerThread === undefined ||
        !holdsUnboundImportedSession(projection.thread, providerThread)
      ) {
        return;
      }
      const adapter = yield* providerAdapters.get(providerThread.providerInstanceId).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorProviderAdapterError({
              commandId: command.commandId,
              providerInstanceId: providerThread.providerInstanceId,
              cause,
            }),
        ),
      );
      yield* bindImportedSession(command, events, {
        adapter,
        providerThread,
        now: yield* DateTime.now,
      });
    },
  );

  /**
   * Claude Code style rewind to just before a sent user message. Refused unless
   * the thread runs on Claude, is idle, and the message started a run still in
   * the conversation. Its failure is recorded like a rollback's.
   */
  const dispatchThreadRewind = Effect.fn("Orchestrator.dispatchThreadRewind")(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "thread.rewind" }>,
    events: Events,
    effects: Effects,
  ) {
    const refuse = (cause: string) =>
      new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause,
      });
    const projection = yield* loadProjectionForCommand(
      command,
      ["providerThreads", "runs", "providerTurns", "attempts", "messages"],
      { turnItemTypes: [], messageRoles: ["user"] },
    );
    if (hasLiveRun(projection)) {
      return yield* refuse("Stop the current turn before rewinding.");
    }
    // A queued message, held or not, would be sent into the rewound chat.
    if (projection.runs.some((run) => run.status === "queued")) {
      return yield* refuse("Send or remove your queued messages before rewinding.");
    }
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === projection.thread.activeProviderThreadId,
    );
    if (providerThread === undefined) {
      return yield* refuse("This thread has no Claude session to rewind yet.");
    }
    const adapter = yield* providerAdapters.get(providerThread.providerInstanceId).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorProviderAdapterError({
            commandId: command.commandId,
            providerInstanceId: providerThread.providerInstanceId,
            cause,
          }),
      ),
    );
    const capabilities = yield* adapter.getCapabilities().pipe(mapDispatchError(command));
    if (capabilities.threads.canRewindToMessage !== true) {
      return yield* refuse("This provider cannot rewind to a message.");
    }
    // Rewinding an imported chat opens its session, as its first turn would.
    const bindsImportedSession = holdsUnboundImportedSession(projection.thread, providerThread);
    if (providerThread.providerSessionId === null && !bindsImportedSession) {
      return yield* refuse("This thread has no Claude session to rewind yet.");
    }
    const restores = threadRewindRestores(command.choice);
    if (restores === null) {
      return yield* refuse("This rewind choice is not available yet.");
    }
    const message = projection.messages.find((candidate) => candidate.id === command.messageId);
    const run =
      message?.runId == null
        ? undefined
        : projection.runs.find((candidate) => candidate.id === message.runId);
    if (message?.role !== "user" || run === undefined || run.userMessageId !== message.id) {
      return yield* refuse("Only a message you sent that started a turn can be rewound.");
    }
    if (run.status === "rolled_back") {
      return yield* refuse("This message was already rewound.");
    }
    if (
      run.status !== "completed" &&
      run.status !== "interrupted" &&
      run.status !== "failed" &&
      run.status !== "cancelled"
    ) {
      return yield* refuse("This message's turn has not finished yet.");
    }
    if (restores.code && runFileCheckpointTurn(projection, run.id) === undefined) {
      return yield* refuse(NO_FILE_SNAPSHOTS_MESSAGE);
    }
    const previousRun = previousConversationRun(projection, run);
    const previousTurn =
      previousRun === undefined ? undefined : providerTurnForRun(projection, previousRun);
    if (
      restores.conversation &&
      previousRun !== undefined &&
      (previousTurn === undefined || previousTurn.providerThreadId !== providerThread.id)
    ) {
      return yield* refuse(
        "Cannot rewind to this message: the turn before it is not part of the current Claude session.",
      );
    }

    const now = yield* DateTime.now;
    if (bindsImportedSession) {
      yield* bindImportedSession(command, events, { adapter, providerThread, now });
    }
    // This rewind becomes the only one whose failure the thread records.
    yield* emit(
      events,
      command,
    )({
      type: "thread.metadata-updated",
      threadId: command.threadId,
      providerInstanceId: projection.thread.providerInstanceId,
      occurredAt: now,
      payload: {
        ...projection.thread,
        rollbackRequestId: command.commandId,
        rollbackFailure: null,
        rollbackCompletion: null,
        updatedAt: now,
      },
    });
    yield* Ref.update(effects, (existing) => [
      ...existing,
      {
        id: `effect:${command.commandId}:provider-thread.rewind:${providerThread.id}:${run.id}`,
        commandId: command.commandId,
        threadId: command.threadId,
        request: {
          type: "provider-thread.rewind",
          providerThreadId: providerThread.id,
          runId: run.id,
          choice: command.choice,
        },
      } satisfies PendingOrchestrationEffectV2,
    ]);
  });

  /** Records that the current rewind finished, so clients waiting on it stop. */
  const dispatchCheckpointRollbackComplete = Effect.fn(
    "Orchestrator.dispatchCheckpointRollbackComplete",
  )(function* (
    command: Extract<
      OrchestrationV2InternalCommand,
      { readonly type: "checkpoint.rollback.complete" }
    >,
    events: Events,
  ) {
    const thread = yield* projectionStore
      .getThread(command.threadId)
      .pipe(mapDispatchError(command));
    if (thread.deletedAt !== null) return;
    if (thread.rollbackRequestId !== command.requestId) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Rollback ${command.requestId} is no longer the thread's current rollback.`,
      });
    }
    const now = yield* DateTime.now;
    yield* emit(
      events,
      command,
    )({
      type: "thread.metadata-updated",
      threadId: command.threadId,
      providerInstanceId: thread.providerInstanceId,
      occurredAt: now,
      payload: {
        ...thread,
        rollbackCompletion: {
          requestId: command.requestId,
          ...(command.notice === undefined ? {} : { notice: command.notice }),
        },
        updatedAt: now,
      },
    });
  });

  return { dispatchThreadRewind, dispatchImportedSessionBind, dispatchCheckpointRollbackComplete };
}
