import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import type { TimelineEntry } from "../../session-logic";
import { orchestrationEnvironment } from "../../state/orchestration";
import { environmentThreadDetails } from "../../state/threads";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import type { ChatMessage } from "../../types";
import {
  decideMessageRewindStart,
  deriveMessageRewindMenu,
  deriveMessageRewindTargets,
  deriveRewindTurnCountByUserMessageId,
  isMessageRewindDisabled,
  loadThreadRewindPreview,
  messageRewindBlockedReason,
  planMessageRewind,
  revertTouchesFiles,
  waitForRewindOutcome,
  waitForThreadToStop,
} from "./messageRewind.logic";

describe("waitForRewindOutcome", () => {
  const threadRef = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("t") };
  const messageId = MessageId.make("message-2");
  const requestId = CommandId.make("rollback-1");

  function projectionAtom() {
    const base = makeThreadProjectionFixture();
    const providerThreadId = ProviderThreadId.make("provider-thread");
    const projection = {
      ...base,
      thread: { ...base.thread, activeProviderThreadId: providerThreadId },
      providerThreads: [
        {
          id: providerThreadId,
          driver: "codex",
          providerInstanceId: base.thread.providerInstanceId,
          providerSessionId: ProviderSessionId.make("provider-session"),
          appThreadId: base.thread.id,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: 1,
          lastRunOrdinal: 4,
          handoffIds: [],
          forkedFrom: null,
          createdAt: base.updatedAt,
          updatedAt: base.updatedAt,
        },
      ],
      runs: [1, 2, 3, 4].map((ordinal) => ({
        id: RunId.make(`run-${ordinal}`),
        threadId: base.thread.id,
        ordinal,
        providerInstanceId: base.thread.providerInstanceId,
        modelSelection: base.thread.modelSelection,
        providerThreadId,
        userMessageId: MessageId.make(`message-${ordinal}`),
        rootNodeId: null,
        activeAttemptId: null,
        status: "completed",
        requestedAt: base.updatedAt,
        startedAt: base.updatedAt,
        completedAt: base.updatedAt,
        checkpointId: null,
        contextHandoffId: null,
      })),
      messages: [
        {
          id: messageId,
          threadId: base.thread.id,
          runId: RunId.make("run-2"),
          nodeId: null,
          role: "user",
          text: "second",
          attachments: [],
          streaming: false,
          createdAt: base.updatedAt,
          updatedAt: base.updatedAt,
        },
      ],
    } as unknown as ReturnType<typeof makeThreadProjectionFixture>;
    const state = Atom.make({ data: Option.some(projection) });
    vi.spyOn(environmentThreadDetails, "stateAtom").mockReturnValue(state as never);
    return { state, projection };
  }

  afterEach(() => vi.restoreAllMocks());

  it("rejects with the projected reason when the rollback fails for good", async () => {
    const { state, projection } = projectionAtom();
    const waiting = waitForRewindOutcome(threadRef, messageId, requestId, async () => {});
    await Promise.resolve();
    appAtomRegistry.set(state, {
      data: Option.some({
        ...projection,
        thread: {
          ...projection.thread,
          rollbackFailure: { requestId, message: "The provider could not roll back." },
        },
      }),
    });

    await expect(waiting).rejects.toThrow("The provider could not roll back.");
  });

  it("resolves once the message's run is rolled back, whatever its ordinal", async () => {
    const { state, projection } = projectionAtom();
    // A turn T3 Code ran on a chat whose three imported prompts were numbered after it.
    const waiting = waitForRewindOutcome(threadRef, messageId, requestId, async () => {});
    await Promise.resolve();
    appAtomRegistry.set(state, {
      data: Option.some({
        ...projection,
        runs: [{ id: RunId.make("run-2"), ordinal: 1, status: "rolled_back" }],
      } as never),
    });

    await expect(waiting).resolves.toBeNull();
  });

  it("resolves with the notice once a code restore finishes, though no turn was rewound", async () => {
    const { state, projection } = projectionAtom();
    const waiting = waitForRewindOutcome(threadRef, messageId, requestId, async () => {});
    await Promise.resolve();
    appAtomRegistry.set(state, {
      data: Option.some({
        ...projection,
        thread: {
          ...projection.thread,
          rollbackCompletion: {
            requestId,
            notice: "Code restored, but 1 file was left as it is: a link made it unsafe to write.",
          },
        },
      }),
    });

    await expect(waiting).resolves.toBe(
      "Code restored, but 1 file was left as it is: a link made it unsafe to write.",
    );
  });

  it("waits for a rewind's notice though its run is rolled back first", async () => {
    const { state, projection } = projectionAtom();
    const waiting = waitForRewindOutcome(threadRef, messageId, requestId, async () => {}, {
      awaitsRecordedOutcome: true,
    });
    // The server accepted the command before its run rolled back.
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    const rolledBack = {
      ...projection,
      thread: { ...projection.thread, rollbackRequestId: requestId },
      runs: [{ id: RunId.make("run-2"), ordinal: 2, status: "rolled_back" }],
    } as never as typeof projection;
    appAtomRegistry.set(state, { data: Option.some(rolledBack) });
    appAtomRegistry.set(state, {
      data: Option.some({
        ...rolledBack,
        thread: {
          ...rolledBack.thread,
          rollbackCompletion: {
            requestId,
            notice: "Code restored, but 1 file was left as it is: a link made it unsafe to write.",
          },
        },
      }),
    });

    await expect(waiting).resolves.toBe(
      "Code restored, but 1 file was left as it is: a link made it unsafe to write.",
    );
  });

  it("resolves a rewind that a later rewind of the same message overtook", async () => {
    const { state, projection } = projectionAtom();
    const waiting = waitForRewindOutcome(threadRef, messageId, requestId, async () => {}, {
      awaitsRecordedOutcome: true,
    });
    // The server accepted the command before its run rolled back.
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    appAtomRegistry.set(state, {
      data: Option.some({
        ...projection,
        thread: { ...projection.thread, rollbackRequestId: CommandId.make("rollback-2") },
        runs: [{ id: RunId.make("run-2"), ordinal: 2, status: "rolled_back" }],
      } as never),
    });

    await expect(waiting).resolves.toBeNull();
  });

  it("ignores a failure recorded for an earlier rollback", async () => {
    vi.useFakeTimers();
    const { state, projection } = projectionAtom();
    const waiting = waitForRewindOutcome(threadRef, messageId, requestId, async () => {}, {
      timeoutMs: 50,
    });
    const settled = expect(waiting).rejects.toThrow("Timed out waiting for the thread to rewind.");
    appAtomRegistry.set(state, {
      data: Option.some({
        ...projection,
        thread: {
          ...projection.thread,
          rollbackFailure: { requestId: CommandId.make("rollback-0"), message: "Old failure." },
        },
      }),
    });
    await vi.advanceTimersByTimeAsync(50);
    await settled;
    vi.useRealTimers();
  });
  it.each([
    ["same", "streamed"],
    ["replacement", "streamed"],
    ["replacement", "refetched"],
  ] as const)(
    "waits for the retained rollback suffix when the edited message and run are paged out (%s provider, %s)",
    async (providerIdentity, projectionSource) => {
      vi.useFakeTimers();
      const { state, projection } = projectionAtom();
      const latestRunId = RunId.make("latest-run-9");
      const latestRun = {
        ...projection.runs[3]!,
        id: latestRunId,
        ordinal: 9,
        userMessageId: MessageId.make("latest-message-9"),
        status: "cancelled" as const,
      };
      const bounded = {
        ...projection,
        messages: [],
        providerThreads: projection.providerThreads.map((thread) => ({
          ...thread,
          lastRunOrdinal: 9,
        })),
        runs: [
          {
            ...latestRun,
            id: RunId.make("old-rewound-run-3"),
            userMessageId: MessageId.make("old-rewound-message-3"),
            ordinal: 3,
            status: "rolled_back" as const,
          },
          latestRun,
        ],
      };
      const oldProviderThread = bounded.providerThreads[0]!;
      const completedProviderThread = {
        ...oldProviderThread,
        ...(providerIdentity === "replacement"
          ? { id: ProviderThreadId.make("replacement-provider-thread"), firstRunOrdinal: null }
          : {}),
        lastRunOrdinal: null,
      };
      appAtomRegistry.set(state, { data: Option.some(bounded) });
      let outcome = "pending";
      const waiting = waitForRewindOutcome(threadRef, messageId, requestId, async () => {}, {
        turnCount: 0,
      }).then(
        () => {
          outcome = "reverted";
        },
        (error: Error) => {
          outcome = error.message;
        },
      );

      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(outcome).toBe("pending");

        appAtomRegistry.set(state, {
          data: Option.some({
            ...bounded,
            thread: {
              ...bounded.thread,
              activeProviderThreadId:
                projectionSource === "refetched"
                  ? completedProviderThread.id
                  : oldProviderThread.id,
            },
            providerThreads:
              providerIdentity === "replacement"
                ? [oldProviderThread, completedProviderThread]
                : [completedProviderThread],
            runs: bounded.runs.map((run) =>
              run.id === latestRunId ? { ...run, status: "rolled_back" as const } : run,
            ),
          }),
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(outcome).toBe("reverted");
        await waiting;
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it.each(["by message id", "paged out"] as const)(
    "waits for the requested target when another client finishes a shallower rewind (%s)",
    async (targeting) => {
      vi.useFakeTimers();
      const { state, projection } = projectionAtom();
      if (targeting === "paged out") {
        appAtomRegistry.set(state, { data: Option.some({ ...projection, messages: [] }) });
      }
      let outcome = "pending";
      const waiting = waitForRewindOutcome(threadRef, messageId, requestId, async () => {}, {
        turnCount: 1,
      }).then(
        () => {
          outcome = "reverted";
        },
        (error: Error) => {
          outcome = error.message;
        },
      );

      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(outcome).toBe("pending");

        // Our command is accepted while the earlier target-3 effect is still running.
        const shallowerRewind = {
          ...projection,
          thread: { ...projection.thread, rollbackRequestId: requestId, rollbackFailure: null },
          providerThreads: projection.providerThreads.map((thread) => ({
            ...thread,
            lastRunOrdinal: 3,
          })),
          runs: projection.runs.map((run) =>
            run.ordinal > 3 ? { ...run, status: "rolled_back" as const } : run,
          ),
        };
        appAtomRegistry.set(state, { data: Option.some(shallowerRewind) });
        await vi.advanceTimersByTimeAsync(0);
        expect(outcome).toBe("pending");

        appAtomRegistry.set(state, {
          data: Option.some({
            ...shallowerRewind,
            providerThreads: shallowerRewind.providerThreads.map((thread) => ({
              ...thread,
              lastRunOrdinal: 1,
            })),
            runs: shallowerRewind.runs.map((run) =>
              run.ordinal > 1 ? { ...run, status: "rolled_back" as const } : run,
            ),
          }),
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(outcome).toBe("reverted");
        await waiting;
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );
  it("rejects a stale edit already rewound by another client during attachment preparation", async () => {
    vi.useFakeTimers();
    const { state, projection } = projectionAtom();
    appAtomRegistry.set(state, {
      data: Option.some({
        ...projection,
        thread: { ...projection.thread, rollbackRequestId: CommandId.make("other-client-rewind") },
        messages: [],
        providerThreads: projection.providerThreads.map((thread) => ({
          ...thread,
          lastRunOrdinal: 1,
        })),
        runs: projection.runs.map((run) =>
          run.ordinal > 1 ? { ...run, status: "rolled_back" as const } : run,
        ),
      }),
    });
    const revert = vi.fn(async () => {});
    let outcome = "pending";
    const waiting = waitForRewindOutcome(threadRef, messageId, requestId, revert, {
      turnCount: 1,
    }).then(
      () => {
        outcome = "reverted";
      },
      () => {
        outcome = "rejected";
      },
    );

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("rejected");
      expect(revert).not.toHaveBeenCalled();
      await waiting;
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
  it("rejects an edit whose message was already rewound by another client", async () => {
    const { state, projection } = projectionAtom();
    appAtomRegistry.set(state, {
      data: Option.some({
        ...projection,
        runs: projection.runs.map((run) =>
          run.ordinal > 1 ? { ...run, status: "rolled_back" as const } : run,
        ),
      }),
    });
    const revert = vi.fn(async () => {});
    await expect(waitForRewindOutcome(threadRef, messageId, requestId, revert)).rejects.toThrow(
      "The thread has changed.",
    );
    expect(revert).not.toHaveBeenCalled();
  });
});

describe("messageRewindBlockedReason", () => {
  it("refuses while a message waits in the queue, even one Stop held", () => {
    expect(
      messageRewindBlockedReason([
        { status: "interrupted" },
        { status: "queued", queueHeld: true },
      ]),
    ).toBe("Send or remove your queued messages before rewinding.");
  });

  it("allows a rewind once nothing waits in the queue", () => {
    expect(
      messageRewindBlockedReason([{ status: "completed" }, { status: "rolled_back" }]),
    ).toBeNull();
  });
});

describe("deriveMessageRewindMenu", () => {
  const rows = (available: { readonly code: boolean }) => [
    { choice: "code-and-conversation", available: available.code },
    { choice: "conversation", available: true },
    { choice: "code", available: available.code },
  ];

  it("enables the code choices, in Claude Code's order, when restoring would change files", () => {
    expect(
      deriveMessageRewindMenu({
        preview: { filesChanged: ["/w/a.ts", "/w/b.ts"], insertions: 3, deletions: 1 },
        error: null,
      }),
    ).toEqual({
      rows: rows({ code: true }),
      note: "Restoring code changes 2 files (+3 -1).",
    });
  });

  it("keeps every choice in place from the first paint, so no button moves under a tap", () => {
    const checking = deriveMessageRewindMenu({ preview: null, error: null });
    const checked = deriveMessageRewindMenu({
      preview: { filesChanged: ["/w/a.ts"], insertions: 1, deletions: 0 },
      error: null,
    });

    expect(checking.rows.map((row) => row.choice)).toEqual(checked.rows.map((row) => row.choice));
    expect(checking).toEqual({ rows: rows({ code: false }), note: "Checking for code changes..." });
  });

  it("disables the code choices when Claude changed no files after the message", () => {
    expect(
      deriveMessageRewindMenu({
        preview: { filesChanged: [], insertions: 0, deletions: 0 },
        error: null,
      }),
    ).toEqual({ rows: rows({ code: false }), note: "Claude changed no files after this message." });
  });

  it("says why there is no code to restore when Claude kept no snapshots", () => {
    expect(
      deriveMessageRewindMenu({
        preview: {
          filesChanged: [],
          insertions: 0,
          deletions: 0,
          unavailableReason: "Claude kept no file snapshots for this message.",
        },
        error: null,
      }),
    ).toEqual({
      rows: rows({ code: false }),
      note: "Claude kept no file snapshots for this message.",
    });
  });

  it("says when the check failed", () => {
    expect(deriveMessageRewindMenu({ preview: null, error: "Connection lost." })).toEqual({
      rows: rows({ code: false }),
      note: "Could not check for code changes: Connection lost.",
    });
  });
});

describe("planMessageRewind", () => {
  const idle = {
    canInterrupt: false,
    isWorking: false,
    supportsMessageRewind: true,
    afterStop: false,
    runs: [{ status: "completed", queueHeld: false }],
  } as const;
  const queued = [
    { status: "running", queueHeld: false },
    { status: "queued", queueHeld: false },
  ] as const;

  it("refuses a Claude rewind while a message waits in the queue, before stopping anything", () => {
    expect(
      planMessageRewind({ ...idle, canInterrupt: true, isWorking: true, runs: queued }),
    ).toEqual({
      kind: "refuse",
      reason: "Send or remove your queued messages before rewinding.",
    });
  });

  it("stops a running turn first", () => {
    expect(
      planMessageRewind({
        ...idle,
        canInterrupt: true,
        isWorking: true,
        runs: [{ status: "running", queueHeld: false }],
      }),
    ).toEqual({ kind: "stop-first" });
  });

  it("refuses when Stop held a queued message while the turn stopped", () => {
    expect(
      planMessageRewind({
        ...idle,
        afterStop: true,
        runs: [
          { status: "interrupted", queueHeld: false },
          { status: "queued", queueHeld: true },
        ],
      }),
    ).toEqual({
      kind: "refuse",
      reason: "Send or remove your queued messages before rewinding.",
    });
  });

  it("asks the user to wait for work that Stop cannot reach", () => {
    expect(planMessageRewind({ ...idle, isWorking: true })).toEqual({
      kind: "refuse",
      reason: "Wait for the current work to finish before rewinding.",
    });
  });

  it("checks with Claude which files a rewind would change", () => {
    expect(planMessageRewind(idle)).toEqual({ kind: "check-files" });
    expect(planMessageRewind({ ...idle, afterStop: true })).toEqual({ kind: "check-files" });
  });

  it("reverts at once for other providers when nothing was running", () => {
    expect(planMessageRewind({ ...idle, supportsMessageRewind: false })).toEqual({
      kind: "revert",
    });
  });

  it("asks other providers' users after a stop, since the stopped turn's files may be unknown", () => {
    expect(planMessageRewind({ ...idle, supportsMessageRewind: false, afterStop: true })).toEqual({
      kind: "ask",
    });
  });

  it("leaves a queue to other providers, whose rollback does not refuse it", () => {
    expect(
      planMessageRewind({
        ...idle,
        supportsMessageRewind: false,
        canInterrupt: true,
        isWorking: true,
        runs: queued,
      }),
    ).toEqual({ kind: "stop-first" });
  });
});

describe("decideMessageRewindStart", () => {
  it("rewinds the conversation at once when Claude changed no files after the message", () => {
    expect(
      decideMessageRewindStart({ preview: { filesChanged: [], insertions: 0, deletions: 0 } }),
    ).toEqual({ kind: "rewind-now" });
  });

  it("asks when restoring code would change files", () => {
    expect(
      decideMessageRewindStart({
        preview: { filesChanged: ["/w/a.ts"], insertions: 2, deletions: 1 },
      }),
    ).toEqual({ kind: "ask" });
  });

  it("asks when the dry run gave no answer, never skipping on an unknown one", () => {
    expect(decideMessageRewindStart({ preview: null })).toEqual({ kind: "ask" });
  });

  it("rewinds at once when Claude kept no snapshots, since no code choice is possible", () => {
    expect(
      decideMessageRewindStart({
        preview: {
          filesChanged: [],
          insertions: 0,
          deletions: 0,
          unavailableReason: "Claude kept no file snapshots for this message.",
        },
      }),
    ).toEqual({ kind: "rewind-now" });
  });
});

describe("waitForThreadToStop", () => {
  const threadRef = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("t") };

  function projectionWithRun(status: string) {
    const base = makeThreadProjectionFixture();
    return {
      ...base,
      runs: [{ id: RunId.make("run-1"), status, queueHeld: false }],
    } as unknown as ReturnType<typeof makeThreadProjectionFixture>;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("resolves once the stopped run is no longer live", async () => {
    const state = Atom.make({ data: Option.some(projectionWithRun("running")) });
    vi.spyOn(environmentThreadDetails, "stateAtom").mockReturnValue(state as never);
    let stopped = false;
    const waiting = waitForThreadToStop(threadRef).then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    appAtomRegistry.set(state, { data: Option.some(projectionWithRun("interrupted")) });

    await waiting;
    expect(stopped).toBe(true);
  });

  it("fails with a reason the user can act on when the run does not stop in time", async () => {
    vi.useFakeTimers();
    const state = Atom.make({ data: Option.some(projectionWithRun("running")) });
    vi.spyOn(environmentThreadDetails, "stateAtom").mockReturnValue(state as never);
    const waiting = waitForThreadToStop(threadRef, 15_000);
    const outcome = expect(waiting).rejects.toThrow(
      "The current turn did not stop. Press Stop, then rewind again.",
    );

    await vi.advanceTimersByTimeAsync(15_000);

    await outcome;
  });
});

describe("loadThreadRewindPreview", () => {
  const target = {
    environmentId: EnvironmentId.make("env-1"),
    threadId: ThreadId.make("t"),
    messageId: MessageId.make("message-2"),
  };

  afterEach(() => vi.restoreAllMocks());

  it("returns Claude's dry run, read from the query the rewind menu shows", async () => {
    const preview = { filesChanged: ["/w/a.ts"], insertions: 2, deletions: 1 };
    const query = Atom.make(AsyncResult.success(preview));
    const family = vi
      .spyOn(orchestrationEnvironment, "threadRewindPreview")
      .mockReturnValue(query as never);

    const loaded = await loadThreadRewindPreview(target);
    loaded.release();

    expect(family).toHaveBeenCalledWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, messageId: target.messageId },
    });
    expect({ preview: loaded.preview, error: loaded.error }).toEqual({ preview, error: null });
  });

  it("returns the failure as an error when the dry run failed", async () => {
    const query = Atom.make(AsyncResult.failure(Cause.fail(new Error("Connection lost."))));
    vi.spyOn(orchestrationEnvironment, "threadRewindPreview").mockReturnValue(query as never);

    const loaded = await loadThreadRewindPreview(target);
    loaded.release();

    expect({ preview: loaded.preview, error: loaded.error }).toEqual({
      preview: null,
      error: "Connection lost.",
    });
  });
});

describe("rewind targets and file checks", () => {
  it("offers a Claude rewind on every sent turn message, with no checkpoint at all", () => {
    const message = (
      id: string,
      role: ChatMessage["role"],
      runId: RunId | null,
      inputIntent?: ChatMessage["inputIntent"],
    ): TimelineEntry => {
      const chatMessage: ChatMessage = {
        id: MessageId.make(id),
        role,
        text: id,
        runId,
        ...(inputIntent === undefined ? {} : { inputIntent }),
        streaming: false,
        createdAt: "2026-06-20T00:00:00.000Z",
        updatedAt: "2026-06-20T00:00:00.000Z",
      };
      return {
        id: chatMessage.id,
        kind: "message",
        createdAt: chatMessage.createdAt,
        message: chatMessage,
      };
    };
    const [run1, run2, run3] = [RunId.make("run-1"), RunId.make("run-2"), RunId.make("run-3")];

    const targets = deriveRewindTurnCountByUserMessageId([
      message("first", "user", run1, "turn_start"),
      message("first-reply", "assistant", run1),
      message("steer", "user", run1, "steer"),
      message("second", "user", run2, "queued_turn"),
      message("third", "user", run3, "turn_start"),
      message("unsent", "user", null, "turn_start"),
    ]);

    expect([...targets]).toEqual([
      [MessageId.make("first"), 0],
      [MessageId.make("second"), 1],
      [MessageId.make("third"), 2],
    ]);
  });

  it("asks about files only when a run after the revert point changed or lost them", () => {
    const checkpoint = (
      turnCount: number,
      status: "ready" | "missing" | "stale",
      files: ReadonlyArray<string>,
    ) => ({
      runId: RunId.make(`run-${turnCount}`),
      checkpointTurnCount: turnCount,
      checkpointRef: `checkpoint-run-${turnCount}` as never,
      status,
      files: files.map((path) => ({ path, kind: "modified", additions: 1, deletions: 0 })),
      assistantMessageId: null,
      completedAt: "2026-06-20T00:00:03.000Z",
    });
    // Runs 1 and 3 changed nothing; run 2 never started.
    const noFileChanges = [checkpoint(1, "ready", []), checkpoint(3, "ready", [])];

    expect(revertTouchesFiles(noFileChanges, 2)).toBe(false);
    expect(revertTouchesFiles([checkpoint(1, "ready", ["a.ts"]), ...noFileChanges], 1)).toBe(false);
    expect(revertTouchesFiles([...noFileChanges, checkpoint(4, "ready", ["a.ts"])], 2)).toBe(true);
    expect(revertTouchesFiles([...noFileChanges, checkpoint(4, "missing", [])], 2)).toBe(true);
    expect(revertTouchesFiles([...noFileChanges, checkpoint(4, "stale", ["a.ts"])], 2)).toBe(false);
  });
});

describe("deriveMessageRewindTargets", () => {
  const userTurn = (id: string, runId: RunId | null): TimelineEntry => {
    const chatMessage: ChatMessage = {
      id: MessageId.make(id),
      role: "user",
      text: id,
      runId,
      inputIntent: "turn_start",
      streaming: false,
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    };
    return {
      id: chatMessage.id,
      kind: "message",
      createdAt: chatMessage.createdAt,
      message: chatMessage,
    };
  };
  const entries = [userTurn("first", RunId.make("run-1")), userTurn("second", RunId.make("run-2"))];

  it("lets a Claude thread rewind to every sent turn, checkpoint or not", () => {
    const targets = deriveMessageRewindTargets({
      timelineEntries: entries,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
      supportsMessageRewind: true,
    });
    expect([...targets]).toEqual([
      [MessageId.make("first"), 0],
      [MessageId.make("second"), 1],
    ]);
  });

  it("offers nothing when the provider can neither rewind nor roll back", () => {
    const targets = deriveMessageRewindTargets({
      timelineEntries: entries,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
      supportsMessageRewind: false,
    });
    expect(targets.size).toBe(0);
  });
});

describe("isMessageRewindDisabled", () => {
  it("is disabled while a rewind is already running", () => {
    expect(
      isMessageRewindDisabled({
        isRevertingCheckpoint: true,
        isWorking: false,
        canInterrupt: true,
      }),
    ).toBe(true);
  });

  it("is disabled while work runs that no Stop can reach", () => {
    expect(
      isMessageRewindDisabled({
        isRevertingCheckpoint: false,
        isWorking: true,
        canInterrupt: false,
      }),
    ).toBe(true);
  });

  it("stays enabled while a stoppable turn runs, since the click stops it", () => {
    expect(
      isMessageRewindDisabled({
        isRevertingCheckpoint: false,
        isWorking: true,
        canInterrupt: true,
      }),
    ).toBe(false);
  });

  it("is enabled when the thread is idle", () => {
    expect(
      isMessageRewindDisabled({
        isRevertingCheckpoint: false,
        isWorking: false,
        canInterrupt: false,
      }),
    ).toBe(false);
  });
});
