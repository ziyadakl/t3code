import { describe, expect, it } from "vite-plus/test";
import {
  computeStableMessagesTimelineRows,
  computeMessageDurationStart,
  deriveMessagesTimelineRows,
  normalizeCompactToolLabel,
  partitionWorkEntriesByError,
  resolveAssistantMessageCopyState,
  isEffectivelyAtEnd,
  isInFlightPrompt,
  lastUserRowIndex,
  userRowIndices,
  nextJumpStep,
  jumpStepTarget,
  shouldShowJumpButton,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";
import { type WorkLogEntry } from "../../session-logic";

describe("isInFlightPrompt", () => {
  it("is true only for the last user row while working", () => {
    expect(isInFlightPrompt(true, true)).toBe(true);
  });

  it("is false when not working, even for the last user row", () => {
    expect(isInFlightPrompt(true, false)).toBe(false);
  });

  it("is false for earlier user rows while working", () => {
    expect(isInFlightPrompt(false, true)).toBe(false);
  });
});

describe("isEffectivelyAtEnd", () => {
  it("is true when already at the end regardless of overflow", () => {
    expect(isEffectivelyAtEnd({ isAtEnd: true, contentLength: 1333, scrollLength: 657 })).toBe(
      true,
    );
  });
  it("is false when content overflows and not at the end", () => {
    expect(isEffectivelyAtEnd({ isAtEnd: false, contentLength: 1333, scrollLength: 657 })).toBe(
      false,
    );
  });
  it("is true when content fits the viewport (nothing to scroll)", () => {
    expect(isEffectivelyAtEnd({ isAtEnd: false, contentLength: 657, scrollLength: 657 })).toBe(
      true,
    );
    expect(isEffectivelyAtEnd({ isAtEnd: false, contentLength: 400, scrollLength: 657 })).toBe(
      true,
    );
  });
});

describe("computeMessageDurationStart", () => {
  it("returns message createdAt when there is no preceding user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:05Z",
        completedAt: "2026-01-01T00:00:10Z",
      },
    ]);
    expect(result).toEqual(new Map([["a1", "2026-01-01T00:00:05Z"]]));
  });

  it("uses the user message createdAt for the first assistant response", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("uses the previous assistant completedAt for subsequent assistant responses", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        completedAt: "2026-01-01T00:00:55Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:30Z"],
      ]),
    );
  });

  it("does not advance the boundary for a streaming message without completedAt", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      { id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:30Z" },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        completedAt: "2026-01-01T00:00:55Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("resets the boundary on a new user message", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
      { id: "u2", role: "user", createdAt: "2026-01-01T00:01:00Z" },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:01:20Z",
        completedAt: "2026-01-01T00:01:20Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["u2", "2026-01-01T00:01:00Z"],
        ["a2", "2026-01-01T00:01:00Z"],
      ]),
    );
  });

  it("handles system messages without affecting the boundary", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      { id: "s1", role: "system", createdAt: "2026-01-01T00:00:01Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["s1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("returns empty map for empty input", () => {
    expect(computeMessageDurationStart([])).toEqual(new Map());
  });
});

describe("normalizeCompactToolLabel", () => {
  it("removes trailing completion wording from command labels", () => {
    expect(normalizeCompactToolLabel("Ran command complete")).toBe("Ran command");
  });

  it("removes trailing completion wording from other labels", () => {
    expect(normalizeCompactToolLabel("Read file completed")).toBe("Read file");
  });
});

describe("resolveAssistantMessageCopyState", () => {
  it("returns enabled copy state for completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Ship it",
        streaming: false,
      }),
    ).toEqual({
      text: "Ship it",
      visible: true,
    });
  });

  it("hides copy while an assistant message is still streaming", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Still streaming",
        streaming: true,
      }),
    ).toEqual({
      text: "Still streaming",
      visible: false,
    });
  });

  it("hides copy for empty completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "   ",
        streaming: false,
      }),
    ).toEqual({
      text: null,
      visible: false,
    });
  });

  it("hides copy for non-terminal assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: false,
        text: "Interim thought",
        streaming: false,
      }),
    ).toEqual({
      text: "Interim thought",
      visible: false,
    });
  });
});

describe("deriveMessagesTimelineRows", () => {
  it("only enables assistant copy for the terminal assistant message in a turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-1-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Write a poem",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "I should ground this first.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            completedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Here is the poem.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            completedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      completionDividerBeforeEntryId: "assistant-final-entry",
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows).toHaveLength(2);
    expect(assistantRows[0]?.showAssistantCopyButton).toBe(false);
    expect(assistantRows[1]?.showAssistantCopyButton).toBe(true);
    expect(assistantRows[1]?.showCompletionDivider).toBe(true);
  });

  it("marks only the active assistant turn as streaming for copy controls", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-one-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-one" as never,
            role: "assistant",
            text: "Earlier response.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            completedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-two-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-two" as never,
            role: "assistant",
            text: "Active response.",
            turnId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:20Z",
            completedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      completionDividerBeforeEntryId: "assistant-two-entry",
      completionSummary: "done",
      isWorking: false,
      activeTurnInProgress: true,
      activeTurnId: "turn-2" as never,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows[0]?.assistantCopyStreaming).toBe(false);
    expect(assistantRows[0]?.completionSummary).toBeNull();
    expect(assistantRows[1]?.assistantCopyStreaming).toBe(true);
    expect(assistantRows[1]?.completionSummary).toBe("done");
  });

  it("projects assistant diff summaries and user revert counts onto the affected rows", () => {
    const assistantTurnDiffSummary = {
      turnId: "turn-1" as never,
      completedAt: "2026-01-01T00:00:30Z",
      assistantMessageId: "assistant-1" as never,
      checkpointTurnCount: 2,
      files: [{ path: "src/index.ts", additions: 3, deletions: 1 }],
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Do the thing",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "Done",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            completedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map([
        ["assistant-1" as never, assistantTurnDiffSummary],
      ]),
      revertTurnCountByUserMessageId: new Map([["user-1" as never, 1]]),
    });

    const userRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "user",
    );
    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(userRow?.revertTurnCount).toBe(1);
    expect(assistantRow?.assistantTurnDiffSummary).toBe(assistantTurnDiffSummary);
  });

  it("flags only the last user row as in-flight-eligible (turnId is always null)", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-1-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "First",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "ok",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            completedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "user-2-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "user-2" as never,
            role: "user",
            text: "Second",
            turnId: null,
            createdAt: "2026-01-01T00:00:20Z",
            streaming: false,
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: true,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const userRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "user",
    );
    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(userRows[0]?.isLastUserRow).toBe(false);
    expect(userRows[1]?.isLastUserRow).toBe(true);
    // Assistant rows are never the in-flight prompt regardless of position.
    expect(assistantRow?.isLastUserRow).toBe(false);
  });
});

describe("deriveMessagesTimelineRows — work grouping", () => {
  it("collapses a run of consecutive work entries into exactly ONE work row of N entries", () => {
    const workEntry = (id: string, tone: WorkLogEntry["tone"]) => ({
      id: `entry-${id}`,
      kind: "work" as const,
      createdAt: "2026-01-01T00:00:00Z",
      entry: {
        id,
        createdAt: "2026-01-01T00:00:00Z",
        label: `work ${id}`,
        tone,
      },
    });

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        workEntry("w1", "tool"),
        workEntry("w2", "thinking"),
        workEntry("w3", "info"),
        workEntry("w4", "error"),
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const workRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "work" }> => row.kind === "work",
    );
    expect(workRows).toHaveLength(1);
    expect(workRows[0]?.groupedEntries).toHaveLength(4);
    // One work-run = one row, at the run's own position/id.
    expect(workRows[0]?.id).toBe("entry-w1");
  });
});

describe("partitionWorkEntriesByError", () => {
  const entry = (id: string, tone: WorkLogEntry["tone"]): WorkLogEntry => ({
    id,
    createdAt: "2026-01-01T00:00:00Z",
    label: `work ${id}`,
    tone,
  });

  it("splits error-tone entries from the rest, preserving order", () => {
    const e1 = entry("e1", "tool");
    const e2 = entry("e2", "error");
    const e3 = entry("e3", "thinking");
    const e4 = entry("e4", "error");

    const { errors, rest } = partitionWorkEntriesByError([e1, e2, e3, e4]);

    expect(errors).toEqual([e2, e4]);
    expect(rest).toEqual([e1, e3]);
  });

  it("returns empty error list when there are no error-tone entries", () => {
    const e1 = entry("e1", "tool");
    const e2 = entry("e2", "info");

    const { errors, rest } = partitionWorkEntriesByError([e1, e2]);

    expect(errors).toEqual([]);
    expect(rest).toEqual([e1, e2]);
  });
});

describe("lastUserRowIndex", () => {
  const userRow = (id: string): MessagesTimelineRow => ({
    kind: "message",
    id,
    createdAt: "2026-01-01T00:00:00Z",
    message: {
      id: id as never,
      role: "user",
      text: "hi",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      streaming: false,
    },
    durationStart: "2026-01-01T00:00:00Z",
    showCompletionDivider: false,
    completionSummary: null,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
    isLastUserRow: false,
  });
  const assistantRow = (id: string): MessagesTimelineRow => ({
    kind: "message",
    id,
    createdAt: "2026-01-01T00:00:10Z",
    message: {
      id: id as never,
      role: "assistant",
      text: "ok",
      turnId: "turn-1" as never,
      createdAt: "2026-01-01T00:00:10Z",
      completedAt: "2026-01-01T00:00:11Z",
      streaming: false,
    },
    durationStart: "2026-01-01T00:00:10Z",
    showCompletionDivider: false,
    completionSummary: null,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
    isLastUserRow: false,
  });
  const workingRow: MessagesTimelineRow = {
    kind: "working",
    id: "working-indicator-row",
    createdAt: null,
  };

  it("returns the index of the last user row among mixed following rows", () => {
    const rows = [userRow("u1"), assistantRow("a1"), workingRow];
    expect(lastUserRowIndex(rows)).toBe(0);
  });

  it("returns -1 when there is no user row", () => {
    const rows = [assistantRow("a1"), workingRow];
    expect(lastUserRowIndex(rows)).toBe(-1);
  });

  it("returns the LAST user row index when there are multiple", () => {
    const rows = [userRow("u1"), assistantRow("a1"), userRow("u2"), assistantRow("a2")];
    expect(lastUserRowIndex(rows)).toBe(2);
  });

  it("derives the last user row index from deriveMessagesTimelineRows output", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-1-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "First",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "ok",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            completedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: true,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(lastUserRowIndex(rows)).toBe(0);
    const target = rows[lastUserRowIndex(rows)];
    expect(target?.kind === "message" && target.message.role === "user").toBe(true);
  });
});

describe("userRowIndices", () => {
  const userRow = (id: string): MessagesTimelineRow => ({
    kind: "message",
    id,
    createdAt: "2026-01-01T00:00:00Z",
    message: {
      id: id as never,
      role: "user",
      text: "hi",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      streaming: false,
    },
    durationStart: "2026-01-01T00:00:00Z",
    showCompletionDivider: false,
    completionSummary: null,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
    isLastUserRow: false,
  });
  const assistantRow = (id: string): MessagesTimelineRow => ({
    kind: "message",
    id,
    createdAt: "2026-01-01T00:00:10Z",
    message: {
      id: id as never,
      role: "assistant",
      text: "ok",
      turnId: "turn-1" as never,
      createdAt: "2026-01-01T00:00:10Z",
      completedAt: "2026-01-01T00:00:11Z",
      streaming: false,
    },
    durationStart: "2026-01-01T00:00:10Z",
    showCompletionDivider: false,
    completionSummary: null,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
    isLastUserRow: false,
  });
  const workingRow: MessagesTimelineRow = {
    kind: "working",
    id: "working-indicator-row",
    createdAt: null,
  };

  it("returns an empty array when there are no rows", () => {
    expect(userRowIndices([])).toEqual([]);
  });

  it("returns an empty array when there are no user rows", () => {
    expect(userRowIndices([assistantRow("a1"), workingRow])).toEqual([]);
  });

  it("returns ascending indices for every user row among mixed rows", () => {
    const rows = [
      userRow("u1"),
      assistantRow("a1"),
      userRow("u2"),
      assistantRow("a2"),
      workingRow,
    ];
    expect(userRowIndices(rows)).toEqual([0, 2]);
  });

  it("agrees with lastUserRowIndex on the final entry", () => {
    const rows = [userRow("u1"), assistantRow("a1"), userRow("u2")];
    const indices = userRowIndices(rows);
    expect(indices.at(-1)).toBe(lastUserRowIndex(rows));
  });
});

describe("nextJumpStep", () => {
  it("targets the most recent user message when idle (cursor null)", () => {
    expect(nextJumpStep(3, null)).toEqual({ pos: 2, nextCursor: 1 });
  });

  it("decrements mid-cycle toward the first user message", () => {
    expect(nextJumpStep(3, 1)).toEqual({ pos: 1, nextCursor: 0 });
  });

  it("clamps at the first user message (position 0)", () => {
    expect(nextJumpStep(3, 0)).toEqual({ pos: 0, nextCursor: 0 });
  });
});

describe("jumpStepTarget", () => {
  it("returns a null row and echoes the cursor when there are no targets (cursor null)", () => {
    expect(jumpStepTarget([], null)).toEqual({ rowIndex: null, nextCursor: null });
  });

  it("returns a null row and echoes the cursor when there are no targets (numeric cursor)", () => {
    expect(jumpStepTarget([], 3)).toEqual({ rowIndex: null, nextCursor: 3 });
  });

  it("targets the single user row on an idle click and settles the cursor at 0", () => {
    expect(jumpStepTarget([4], null)).toEqual({ rowIndex: 4, nextCursor: 0 });
  });

  it("clamps a single-target repeat click at the first (only) user row", () => {
    expect(jumpStepTarget([4], 0)).toEqual({ rowIndex: 4, nextCursor: 0 });
  });

  it("targets the most recent user row on an idle multi-target click", () => {
    expect(jumpStepTarget([2, 5, 9], null)).toEqual({ rowIndex: 9, nextCursor: 1 });
  });

  it("steps back to the middle user row mid-cycle", () => {
    expect(jumpStepTarget([2, 5, 9], 1)).toEqual({ rowIndex: 5, nextCursor: 0 });
  });

  it("clamps at the first user row on a multi-target repeat click", () => {
    expect(jumpStepTarget([2, 5, 9], 0)).toEqual({ rowIndex: 2, nextCursor: 0 });
  });

  it("guards a stale out-of-range cursor by returning a null row", () => {
    expect(jumpStepTarget([2, 5], 5)).toEqual({ rowIndex: null, nextCursor: 4 });
  });
});

describe("shouldShowJumpButton", () => {
  it("is hidden when there are no user messages", () => {
    expect(
      shouldShowJumpButton({ targetsLength: 0, cursor: null, latestVisible: false }),
    ).toBe(false);
  });

  it("is hidden when idle and the latest user message is already visible", () => {
    expect(
      shouldShowJumpButton({ targetsLength: 2, cursor: null, latestVisible: true }),
    ).toBe(false);
  });

  it("is shown when idle and the latest user message is off screen", () => {
    expect(
      shouldShowJumpButton({ targetsLength: 2, cursor: null, latestVisible: false }),
    ).toBe(true);
  });

  it("stays shown mid-cycle even when the latest user message is visible", () => {
    expect(
      shouldShowJumpButton({ targetsLength: 2, cursor: 0, latestVisible: true }),
    ).toBe(true);
  });
});

describe("computeStableMessagesTimelineRows", () => {
  it("returns the previous result when row order and content are unchanged", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      turnId: null,
      createdAt: "2026-01-01T00:00:10Z",
      streaming: false,
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-user-1",
          kind: "message",
          createdAt: firstUserMessage.createdAt,
          message: firstUserMessage,
        },
        {
          id: "entry-user-2",
          kind: "message",
          createdAt: secondUserMessage.createdAt,
          message: secondUserMessage,
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const initial = computeStableMessagesTimelineRows(rows, {
      byId: new Map(),
      result: [],
    });

    const repeated = computeStableMessagesTimelineRows(rows, initial);

    expect(repeated).toBe(initial);
    expect(repeated.result).toBe(initial.result);
  });

  it("reuses work rows when equivalent timeline derivations create new grouped arrays", () => {
    const firstWorkEntry = {
      id: "work-1",
      createdAt: "2026-01-01T00:00:00Z",
      label: "thinking",
      detail: "Inspecting repository state",
      tone: "thinking" as const,
    };
    const secondWorkEntry = {
      id: "work-2",
      createdAt: "2026-01-01T00:00:01Z",
      label: "read",
      detail: "Reading package.json",
      tone: "tool" as const,
    };

    const createRows = () =>
      deriveMessagesTimelineRows({
        timelineEntries: [
          {
            id: "entry-work-1",
            kind: "work",
            createdAt: firstWorkEntry.createdAt,
            entry: firstWorkEntry,
          },
          {
            id: "entry-work-2",
            kind: "work",
            createdAt: secondWorkEntry.createdAt,
            entry: secondWorkEntry,
          },
        ],
        completionDividerBeforeEntryId: null,
        isWorking: false,
        activeTurnStartedAt: null,
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });

    const firstRows = createRows();
    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });
    const secondRows = createRows();

    expect(secondRows[0]).not.toBe(firstRows[0]);

    const repeated = computeStableMessagesTimelineRows(secondRows, initial);

    expect(repeated).toBe(initial);
    expect(repeated.result[0]).toBe(initial.result[0]);
  });

  it("returns a new result when row order changes without content changes", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      turnId: null,
      createdAt: "2026-01-01T00:00:10Z",
      streaming: false,
    };

    const firstRows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-user-1",
          kind: "message",
          createdAt: firstUserMessage.createdAt,
          message: firstUserMessage,
        },
        {
          id: "entry-user-2",
          kind: "message",
          createdAt: secondUserMessage.createdAt,
          message: secondUserMessage,
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });

    const reordered = computeStableMessagesTimelineRows([firstRows[1]!, firstRows[0]!], initial);

    expect(reordered).not.toBe(initial);
    expect(reordered.result).toEqual([initial.result[1], initial.result[0]]);
  });
});
