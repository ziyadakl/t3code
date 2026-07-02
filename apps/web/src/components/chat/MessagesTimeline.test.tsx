import { EnvironmentId, MessageId, TurnId } from "@t3tools/contracts";
import { createRef, type ReactNode, type Ref } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { LegendListRef } from "@legendapp/list/react";

// Capture the props MessagesTimeline hands to the rewind control so we can
// assert the enable/route wiring (Feature C) without a DOM. The real click ->
// onRestoreConversation behavior of RewindMenu is proven in RewindMenu.test.tsx;
// here we verify what MessagesTimeline routes into it per row.
interface CapturedRewindProps {
  messageId: MessageId;
  hasCheckpoint: boolean;
  disabled?: boolean;
  onRestoreConversation: (messageId: MessageId) => void;
  onRestoreConversationAndFiles: (messageId: MessageId) => void;
}
const rewindMenuProps: CapturedRewindProps[] = [];

vi.mock("./RewindMenu", () => ({
  RewindMenu: (props: CapturedRewindProps) => {
    rewindMenuProps.push(props);
    return <button data-testid={`rewind-${props.messageId}`} disabled={props.disabled} />;
  },
}));

vi.mock("@legendapp/list/react", async () => {
  const legendListTestId = "legend-list";

  const LegendList = (props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    ref?: Ref<LegendListRef>;
  }) => (
    <div data-testid={legendListTestId}>
      {props.ListHeaderComponent}
      {props.data.map((item) => (
        <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
      ))}
      {props.ListFooterComponent}
    </div>
  );

  return { LegendList };
});

function MockFileDiff(props: {
  fileDiff: { name?: string | null; prevName?: string | null };
  renderCustomHeader?: (fileDiff: {
    name?: string | null;
    prevName?: string | null;
  }) => React.ReactNode;
}) {
  return (
    <div data-testid="file-diff">
      {props.renderCustomHeader?.(props.fileDiff)}
      {props.fileDiff.name ?? props.fileDiff.prevName ?? "diff"}
    </div>
  );
}

vi.mock("@pierre/diffs/react", () => {
  return { FileDiff: MockFileDiff };
});

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

beforeAll(() => {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });
});

const ACTIVE_THREAD_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const MESSAGE_CREATED_AT = "2026-03-17T19:12:28.000Z";

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnId: null,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    completionDividerBeforeEntryId: null,
    completionSummary: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRewindConversation: () => {},
    onRewindConversationAndFiles: () => {},
    onInterruptAndRewind: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    onIsAtEndChange: () => {},
    agentEditSetByTurnId: new Map(),
  };
}

function buildLongUserMessageText(tail = "deep hidden detail only after expand") {
  return Array.from({ length: 9 }, (_, index) =>
    index === 8 ? tail : `Line ${index + 1}: ${"verbose prompt content ".repeat(8).trim()}`,
  ).join("\n");
}

function buildUserTimelineEntry(text: string) {
  return {
    id: "entry-1",
    kind: "message" as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: MessageId.make("message-1"),
      role: "user" as const,
      text,
      createdAt: MESSAGE_CREATED_AT,
      streaming: false,
    },
  };
}

describe("MessagesTimeline", () => {
  it("renders collapse controls for long user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain("Show full message");
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-fade="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("does not render collapse controls for short user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("Short prompt.")]}
      />,
    );

    expect(markup).not.toContain("Show full message");
    expect(markup).toContain('data-user-message-collapsible="false"');
  });

  it("renders inline terminal labels with the composer chip UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              buildLongUserMessageText("yoo what's @terminal-1:1-5 mean"),
              "",
              "<terminal_context>",
              "- Terminal 1 lines 1-5:",
              "  1 | julius@mac effect-http-ws-cli % bun i",
              "  2 | bun install v1.3.9 (cf6cdbbb)",
              "</terminal_context>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("yoo what&#x27;s ");
    expect(markup).toContain("Show full message");
  }, 20_000);

  it("keeps the copy button for collapsed long user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain('aria-label="Copy link"');
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("collapses a single non-error work entry behind a terse actions summary", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Context compacted",
              tone: "info",
            },
          },
        ]}
      />,
    );

    // Terse "1 action" summary, no worklog card chrome, collapsed by default.
    expect(markup).toContain("1 action");
    expect(markup).not.toContain("Work log");
    expect(markup).not.toContain("Context compacted");
  });

  it("renders a terse '{N} actions' summary and drops the worklog card chrome", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const workEntry = (id: string, label: string) => ({
      id: `entry-${id}`,
      kind: "work" as const,
      createdAt: "2026-03-17T19:12:28.000Z",
      entry: {
        id,
        createdAt: "2026-03-17T19:12:28.000Z",
        label,
        tone: "tool" as const,
      },
    });

    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          workEntry("w1", "Ran build"),
          workEntry("w2", "Read file"),
          workEntry("w3", "Edited file"),
        ]}
      />,
    );

    expect(markup).toContain("3 actions");
    // Old bordered card chrome + header are gone.
    expect(markup).not.toContain("rounded-xl border border-border/45 bg-card/25");
    expect(markup).not.toContain("Work log");
    expect(markup).not.toContain("Tool calls");
    // Collapsed by default: individual entry labels are hidden.
    expect(markup).not.toContain("Ran build");
  });

  it("keeps error-tone work entries visible even while collapsed", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Command failed loudly",
              tone: "error",
            },
          },
          {
            id: "entry-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-2",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Quietly read a file",
              tone: "tool",
            },
          },
        ]}
      />,
    );

    // Error entry is always visible; the non-error one stays behind the summary.
    expect(markup).toContain("Command failed loudly");
    expect(markup).toContain("1 action");
    expect(markup).not.toContain("Quietly read a file");
  });

  it("formats changed file paths from the workspace root", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Updated files",
              // Error tone keeps the entry always-visible so its changed-file
              // path rendering is observable in the collapsed (SSR) markup.
              tone: "error",
              changedFiles: ["C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts"],
            },
          },
        ]}
        workspaceRoot="C:/Users/mike/dev-stuff/t3code"
      />,
    );

    expect(markup).toContain("t3code/apps/web/src/session-logic.ts");
    expect(markup).not.toContain("C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts");
  });

  it("renders review comment contexts as structured cards instead of raw tags", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-2"),
              role: "user",
              text: [
                '<review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="apps/web/src/lib/contextWindow.test.ts" startIndex="3" endIndex="14" rangeLabel="+47 to +58">',
                "Wadduo",
                "```diff",
                "@@ -0,0 +47,2 @@",
                '+  it("keeps valid zero-usage snapshots", () => {',
                "+    expect(snapshot).not.toBeNull();",
                "```",
                "</review_comment>",
              ].join("\n"),
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("contextWindow.test.ts");
    expect(markup).toContain("Wadduo");
    expect(markup).toContain('data-testid="file-diff"');
    expect(markup).not.toContain(">Review comment<");
    expect(markup).not.toContain("&lt;review_comment");
    expect(markup).not.toContain("&lt;/review_comment&gt;");
  });
});

describe("MessagesTimeline — in-flight prompt rewind (Feature C)", () => {
  const ACTIVE_TURN = TurnId.make("turn-active");
  const ACTIVE_MESSAGE = MessageId.make("message-active");
  const PRIOR_MESSAGE = MessageId.make("message-prior");

  // Production-accurate: user prompts are ALWAYS persisted with turnId null
  // (decider.ts stamps role:"user" events with turnId: null). The in-flight
  // prompt is therefore the LAST user row while a turn runs — never a turnId
  // match. See MessagesTimeline.logic.ts:isInFlightPrompt.
  function buildUserEntry(entryId: string, messageId: MessageId) {
    return {
      id: entryId,
      kind: "message" as const,
      createdAt: MESSAGE_CREATED_AT,
      message: {
        id: messageId,
        role: "user" as const,
        text: `prompt for ${entryId}`,
        turnId: null,
        createdAt: MESSAGE_CREATED_AT,
        streaming: false,
      },
    };
  }

  it("enables the last user prompt's rewind (in-flight) and routes it to interrupt-and-rewind", async () => {
    rewindMenuProps.length = 0;
    const onRewindConversation = vi.fn();
    const onInterruptAndRewind = vi.fn();
    const { MessagesTimeline } = await import("./MessagesTimeline");

    renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnInProgress
        activeTurnId={ACTIVE_TURN}
        onRewindConversation={onRewindConversation}
        onInterruptAndRewind={onInterruptAndRewind}
        timelineEntries={[
          buildUserEntry("entry-prior", PRIOR_MESSAGE),
          buildUserEntry("entry-active", ACTIVE_MESSAGE),
        ]}
      />,
    );

    const priorProps = rewindMenuProps.find((p) => p.messageId === PRIOR_MESSAGE);
    const activeProps = rewindMenuProps.find((p) => p.messageId === ACTIVE_MESSAGE);
    if (!priorProps || !activeProps) {
      throw new Error("expected rewind controls for both user prompts");
    }

    // Earlier prompt stays disabled while a turn runs.
    expect(priorProps.disabled).toBe(true);
    // The last (just-sent, in-flight) prompt is clickable so it can
    // interrupt+rewind — even though its turnId is null.
    expect(activeProps.disabled).toBe(false);

    // Clicking the enabled control routes to interrupt-and-rewind, not the
    // plain conversation rewind.
    activeProps.onRestoreConversation(activeProps.messageId);
    expect(onInterruptAndRewind).toHaveBeenCalledTimes(1);
    expect(onInterruptAndRewind).toHaveBeenCalledWith(ACTIVE_MESSAGE);
    expect(onRewindConversation).not.toHaveBeenCalled();

    // The earlier prompt still routes through the ordinary conversation rewind.
    expect(priorProps.onRestoreConversation).toBe(onRewindConversation);
  });

  it("leaves every prompt clickable through the ordinary rewind when idle", async () => {
    rewindMenuProps.length = 0;
    const onRewindConversation = vi.fn();
    const onInterruptAndRewind = vi.fn();
    const { MessagesTimeline } = await import("./MessagesTimeline");

    renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        onRewindConversation={onRewindConversation}
        onInterruptAndRewind={onInterruptAndRewind}
        timelineEntries={[
          buildUserEntry("entry-prior", PRIOR_MESSAGE),
          buildUserEntry("entry-active", ACTIVE_MESSAGE),
        ]}
      />,
    );

    const activeProps = rewindMenuProps.find((p) => p.messageId === ACTIVE_MESSAGE);
    if (!activeProps) {
      throw new Error("expected rewind control for the last user prompt");
    }

    // Idle: even the last prompt is a normal conversation rewind, not interrupt.
    expect(activeProps.disabled).toBe(false);
    expect(activeProps.onRestoreConversation).toBe(onRewindConversation);
    expect(onInterruptAndRewind).not.toHaveBeenCalled();
  });
});
