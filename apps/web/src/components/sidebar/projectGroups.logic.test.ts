import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import type { SidebarListItem } from "../Sidebar.logic";
import type { Thread } from "../../types";
import { makeThreadFixture, type ThreadFixtureOverrides } from "../../test-fixtures";
import {
  buildSidebarGroupedActiveModel,
  buildSidebarGroupedActiveRows,
  resolveSidebarProjectGroupCounts,
  resolveSidebarThreadAttention,
  sidebarProjectGroupFoldKey,
  sidebarProjectGroupToOpenOnDrop,
  toggleSidebarProjectGroupOpen,
} from "./projectGroups.logic";

const localEnvironmentId = EnvironmentId.make("environment-local");

function makeLatestRun(): NonNullable<Thread["latestRun"]> {
  return {
    runId: "turn-1" as never,
    status: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: "2026-03-09T10:00:00.000Z",
    completedAt: "2026-03-09T10:05:00.000Z",
  };
}

describe("buildSidebarGroupedActiveModel", () => {
  const DEFAULT_FLOAT = new Set(["done", "input", "approval", "failed"] as const);
  const alpha = {
    projectKey: "alpha",
    displayName: "Alpha",
    memberProjectRefs: [
      { environmentId: localEnvironmentId, projectId: ProjectId.make("p-alpha") },
    ],
  };
  const beta = {
    projectKey: "beta",
    displayName: "Beta",
    memberProjectRefs: [{ environmentId: localEnvironmentId, projectId: ProjectId.make("p-beta") }],
  };

  // Unless a test sets createdAt, each thread is a minute older than the one
  // made before it, so threads listed newest first are already in activity order.
  let age = 0;
  function thread(
    id: string,
    projectId: string,
    overrides: ThreadFixtureOverrides & { unread?: boolean; woke?: boolean } = {},
  ) {
    const { unread = false, woke = false, ...rest } = overrides;
    age += 1;
    return {
      ...makeThreadFixture({
        id: ThreadId.make(id),
        environmentId: localEnvironmentId,
        projectId: ProjectId.make(projectId),
        runtime: null,
        createdAt: new Date(Date.UTC(2026, 2, 9, 12) - age * 60_000).toISOString(),
        ...rest,
      }),
      unread,
      woke,
    };
  }
  const attention = (t: { unread: boolean; woke: boolean }) => ({
    isUnread: t.unread,
    isWoke: t.woke,
  });
  const ids = (threads: ReadonlyArray<{ id: string }>) => threads.map((t) => t.id);
  const failedRuntime = (lastErrorClass: "usage_limit" | null = null) => ({
    status: "failed" as const,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: null,
    lastError: "boom",
    lastErrorClass,
    updatedAt: "2026-03-09T10:00:00.000Z",
  });

  it("floats an unread Done thread and keeps a read one in its group", () => {
    const model = buildSidebarGroupedActiveModel({
      activeThreads: [
        thread("unread-done", "p-alpha", { unread: true }),
        thread("read-done", "p-alpha"),
      ],
      projects: [alpha],
      floatStatuses: DEFAULT_FLOAT,
      resolveAttention: attention,
    });

    expect(ids(model.floating)).toEqual(["unread-done"]);
    expect(model.groups.map((g) => [g.projectKey, g.displayName, ids(g.threads)])).toEqual([
      ["alpha", "Alpha", ["read-done"]],
    ]);
  });

  it("keeps Woke threads folded by default but counts them on the header", () => {
    const model = buildSidebarGroupedActiveModel({
      activeThreads: [
        thread("woke-1", "p-alpha", { woke: true }),
        thread("woke-2", "p-alpha", { woke: true }),
        thread("failed", "p-alpha", { runtime: failedRuntime() }),
        thread("read", "p-alpha"),
      ],
      projects: [alpha],
      floatStatuses: DEFAULT_FLOAT,
      resolveAttention: attention,
    });

    expect(ids(model.floating)).toEqual(["failed"]);
    expect(ids(model.groups[0]!.threads)).toEqual(["woke-1", "woke-2", "read"]);
    // The floating Failed thread is not counted twice.
    expect(model.groups[0]!.statusCounts).toEqual({ woke: 2 });
  });

  it("shows no counts on a group with nothing unread", () => {
    const model = buildSidebarGroupedActiveModel({
      activeThreads: [thread("read-1", "p-alpha"), thread("read-2", "p-alpha")],
      projects: [alpha],
      floatStatuses: DEFAULT_FLOAT,
      resolveAttention: attention,
    });

    expect(model.groups[0]!.statusCounts).toEqual({});
  });

  it("follows a custom float set: Woke floats, Failed stays in its group", () => {
    const model = buildSidebarGroupedActiveModel({
      activeThreads: [
        thread("woke", "p-alpha", { woke: true }),
        thread("failed", "p-alpha", { runtime: failedRuntime() }),
        thread("limited", "p-alpha", { runtime: failedRuntime("usage_limit") }),
      ],
      projects: [alpha],
      floatStatuses: new Set(["done", "input", "approval", "woke"] as const),
      resolveAttention: attention,
    });

    expect(ids(model.floating)).toEqual(["woke"]);
    expect(ids(model.groups[0]!.threads)).toEqual(["failed", "limited"]);
  });

  it("counts only what still needs you: unread, woke, or waiting on an answer", () => {
    const model = buildSidebarGroupedActiveModel({
      activeThreads: [
        thread("read-failed", "p-alpha", { runtime: failedRuntime() }),
        thread("read-limited", "p-alpha", { runtime: failedRuntime("usage_limit") }),
        thread("unread-failed", "p-alpha", { runtime: failedRuntime(), unread: true }),
        thread("input", "p-alpha", { hasPendingUserInput: true }),
        thread("approval", "p-alpha", { hasPendingApprovals: true }),
        thread("woke", "p-alpha", { woke: true }),
        thread("done", "p-alpha", { unread: true }),
      ],
      projects: [alpha],
      // Nothing floats, so every thread stays in the group.
      floatStatuses: new Set(),
      resolveAttention: attention,
    });

    expect(model.groups[0]!.statusCounts).toEqual({
      failed: 1,
      input: 1,
      approval: 1,
      woke: 1,
      done: 1,
    });
  });

  it("floats threads in inbox order across projects", () => {
    const model = buildSidebarGroupedActiveModel({
      activeThreads: [
        thread("beta-input", "p-beta", { hasPendingUserInput: true }),
        thread("alpha-approval", "p-alpha", { hasPendingApprovals: true }),
        thread("beta-done", "p-beta", { unread: true }),
      ],
      projects: [alpha, beta],
      floatStatuses: DEFAULT_FLOAT,
      resolveAttention: attention,
    });

    expect(ids(model.floating)).toEqual(["beta-input", "alpha-approval", "beta-done"]);
    expect(model.groups).toEqual([]);
  });

  it("orders groups and their threads by newest activity, not by the order handed in", () => {
    const at = (hour: number) => `2026-03-09T${String(hour).padStart(2, "0")}:00:00.000Z`;
    const model = buildSidebarGroupedActiveModel({
      // Handed in creation/manual order, which disagrees with activity.
      activeThreads: [
        thread("alpha-old", "p-alpha", { createdAt: at(8) }),
        thread("orphan", "p-deleted", { createdAt: at(9) }),
        thread("beta-old", "p-beta", { createdAt: at(10) }),
        thread("alpha-new", "p-alpha", { createdAt: at(11) }),
        thread("beta-new", "p-beta", { createdAt: at(12) }),
      ],
      projects: [alpha, beta],
      floatStatuses: DEFAULT_FLOAT,
      resolveAttention: attention,
    });

    expect(model.groups.map((g) => [g.projectKey, g.displayName, ids(g.threads)])).toEqual([
      ["beta", "Beta", ["beta-new", "beta-old"]],
      ["alpha", "Alpha", ["alpha-new", "alpha-old"]],
      // "No project" is placed by the same rule.
      [null, "No project", ["orphan"]],
    ]);
  });

  it("counts a run finishing as activity", () => {
    const model = buildSidebarGroupedActiveModel({
      activeThreads: [
        thread("beta", "p-beta", { createdAt: "2026-03-09T09:00:00.000Z" }),
        thread("alpha", "p-alpha", {
          createdAt: "2026-03-09T08:00:00.000Z",
          latestRun: { ...makeLatestRun(), completedAt: "2026-03-09T10:00:00.000Z" },
        }),
      ],
      projects: [alpha, beta],
      floatStatuses: DEFAULT_FLOAT,
      resolveAttention: attention,
    });

    expect(model.groups.map((g) => g.projectKey)).toEqual(["alpha", "beta"]);
  });

  it("ranks a group by all its threads, floating ones included", () => {
    const model = buildSidebarGroupedActiveModel({
      activeThreads: [
        thread("beta", "p-beta", { createdAt: "2026-03-09T10:00:00.000Z" }),
        thread("alpha-read", "p-alpha", { createdAt: "2026-03-09T09:00:00.000Z" }),
        // Floats to Needs you, yet still makes Alpha the newest project.
        thread("alpha-done", "p-alpha", { createdAt: "2026-03-09T11:00:00.000Z", unread: true }),
      ],
      projects: [alpha, beta],
      floatStatuses: DEFAULT_FLOAT,
      resolveAttention: attention,
    });

    expect(ids(model.floating)).toEqual(["alpha-done"]);
    expect(model.groups.map((g) => g.projectKey)).toEqual(["alpha", "beta"]);
  });

  describe("sidebarProjectGroupToOpenOnDrop", () => {
    const drop = (dropped: ReturnType<typeof thread>, openFoldKeys: readonly string[] = []) =>
      sidebarProjectGroupToOpenOnDrop({
        thread: dropped,
        projects: [alpha, beta],
        floatStatuses: DEFAULT_FLOAT,
        resolveAttention: attention,
        openFoldKeys,
      });

    it("opens the folded group a thread dropped into the inbox lands in", () => {
      expect(drop(thread("read", "p-alpha"))).toBe(sidebarProjectGroupFoldKey("alpha"));
      expect(drop(thread("orphan", "p-deleted"))).toBe(sidebarProjectGroupFoldKey(null));
    });

    it("opens nothing when the thread floats or its group is already open", () => {
      expect(drop(thread("done", "p-alpha", { unread: true }))).toBeNull();
      expect(drop(thread("read", "p-alpha"), [sidebarProjectGroupFoldKey("alpha")])).toBeNull();
    });
  });

  it("puts the same project on two machines into one group", () => {
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const shared = {
      projectKey: "shared",
      displayName: "Shared",
      memberProjectRefs: [
        { environmentId: localEnvironmentId, projectId: ProjectId.make("p-local") },
        { environmentId: remoteEnvironmentId, projectId: ProjectId.make("p-remote") },
      ],
    };
    const model = buildSidebarGroupedActiveModel({
      activeThreads: [
        thread("on-remote", "p-remote", { environmentId: remoteEnvironmentId, woke: true }),
        thread("on-local", "p-local"),
      ],
      projects: [shared],
      floatStatuses: DEFAULT_FLOAT,
      resolveAttention: attention,
    });

    expect(model.groups.map((g) => [g.projectKey, ids(g.threads), g.statusCounts])).toEqual([
      ["shared", ["on-remote", "on-local"], { woke: 1 }],
    ]);
  });
});

describe("resolveSidebarThreadAttention", () => {
  // The run in makeLatestRun completes at 10:05.
  const visitedThread = (lastVisitedAt: string | null) =>
    makeThreadFixture({ latestRun: makeLatestRun(), lastVisitedAt });

  it("reads a completion after the last visit as unread", () => {
    expect(
      resolveSidebarThreadAttention({
        thread: visitedThread("2026-03-09T10:00:00.000Z"),
        localLastVisitedAt: undefined,
        wokeAt: null,
      }),
    ).toEqual({ isUnread: true, isWoke: false });
    expect(
      resolveSidebarThreadAttention({
        thread: visitedThread("2026-03-09T10:06:00.000Z"),
        localLastVisitedAt: undefined,
        wokeAt: null,
      }),
    ).toEqual({ isUnread: false, isWoke: false });
  });

  it("is woke until the thread is visited after the wake", () => {
    const wokeAt = "2026-03-09T11:00:00.000Z";
    expect(
      resolveSidebarThreadAttention({
        thread: visitedThread("2026-03-09T10:06:00.000Z"),
        localLastVisitedAt: undefined,
        wokeAt,
      }).isWoke,
    ).toBe(true);
    expect(
      resolveSidebarThreadAttention({
        thread: visitedThread("2026-03-09T11:01:00.000Z"),
        localLastVisitedAt: undefined,
        wokeAt,
      }).isWoke,
    ).toBe(false);
  });

  it("uses the local visit when the server does not track visits", () => {
    const thread = {
      ...makeThreadFixture({ latestRun: makeLatestRun() }),
      lastVisitedAt: undefined,
    };
    expect(
      resolveSidebarThreadAttention({
        thread,
        localLastVisitedAt: "2026-03-09T10:06:00.000Z",
        wokeAt: "2026-03-09T10:03:00.000Z",
      }),
    ).toEqual({ isUnread: false, isWoke: false });
  });
});

describe("toggleSidebarProjectGroupOpen", () => {
  const projectKeys = ["alpha", "beta"];

  it("opens a folded group and folds an open one, leaving others alone", () => {
    const opened = toggleSidebarProjectGroupOpen(
      ["beta"],
      sidebarProjectGroupFoldKey("alpha"),
      projectKeys,
    );
    expect(opened).toEqual(["beta", "alpha"]);
    expect(
      toggleSidebarProjectGroupOpen(opened, sidebarProjectGroupFoldKey("alpha"), projectKeys),
    ).toEqual(["beta"]);
  });

  it("keeps the No project group apart from any real project key", () => {
    const noProject = sidebarProjectGroupFoldKey(null);
    expect(noProject).not.toBe(sidebarProjectGroupFoldKey("No project"));
    expect(noProject).not.toBe(sidebarProjectGroupFoldKey(""));
    expect(toggleSidebarProjectGroupOpen([], noProject, projectKeys)).toEqual([noProject]);
  });

  it("drops saved open groups whose project no longer exists", () => {
    const noProject = sidebarProjectGroupFoldKey(null);
    expect(
      toggleSidebarProjectGroupOpen(
        ["deleted", noProject, "beta"],
        sidebarProjectGroupFoldKey("alpha"),
        projectKeys,
      ),
    ).toEqual([noProject, "beta", "alpha"]);
  });
});

describe("buildSidebarGroupedActiveRows", () => {
  type Row = { readonly key: string };
  const row = (key: string): Row => ({ key });
  const model = {
    floating: [row("done-1"), row("input-1")],
    groups: [
      {
        projectKey: "alpha",
        displayName: "Alpha",
        threads: [row("a1"), row("a2")],
        statusCounts: {},
      },
      { projectKey: null, displayName: "No project", threads: [row("n1")], statusCounts: {} },
    ],
  };
  const build = (openFoldKeys: readonly string[], routeThreadKey: string | null = null) =>
    buildSidebarGroupedActiveRows({
      model,
      openFoldKeys,
      routeThreadKey,
      threadKey: (thread) => thread.key,
    });
  const describeItems = (items: readonly SidebarListItem[]) =>
    items.map((item) =>
      item.kind === "thread"
        ? item.key
        : item.marker === "project-group"
          ? `${item.displayName} (${item.open ? "open" : "folded"})`
          : item.marker,
    );

  it("lists Needs you rows, then a header per folded group and nothing inside", () => {
    const { items, visibleThreads } = build([]);
    expect(describeItems(items)).toEqual([
      "needs-you-header",
      "done-1",
      "input-1",
      "Alpha (folded)",
      "No project (folded)",
    ]);
    expect(visibleThreads.map((thread) => thread.key)).toEqual(["done-1", "input-1"]);
  });

  it("shows an open group's threads under its header", () => {
    const { items, visibleThreads } = build([sidebarProjectGroupFoldKey(null)]);
    expect(describeItems(items).slice(3)).toEqual(["Alpha (folded)", "No project (open)", "n1"]);
    expect(visibleThreads.map((thread) => thread.key)).toEqual(["done-1", "input-1", "n1"]);
  });

  it("keeps the open thread's row visible under its folded header without opening it", () => {
    const { items } = build([], "a2");
    expect(describeItems(items).slice(3)).toEqual(["Alpha (folded)", "a2", "No project (folded)"]);
  });

  it("gives each header its group's fold key and data", () => {
    const { items } = build([]);
    expect(items[3]).toEqual({
      kind: "marker",
      marker: "project-group",
      foldKey: sidebarProjectGroupFoldKey("alpha"),
      open: false,
      projectKey: "alpha",
      displayName: "Alpha",
      statusCounts: {},
    });
  });
});

describe("resolveSidebarProjectGroupCounts", () => {
  it("lists a folded header's counts most urgent first, labelled like the row badges", () => {
    expect(
      resolveSidebarProjectGroupCounts(
        { woke: 4, done: 2, failed: 1, waiting: 1 },
        { open: false },
      ),
    ).toEqual([
      { status: "failed", count: 1, label: "Failed", className: "text-error-foreground" },
      { status: "woke", count: 4, label: "Woke", className: "text-warning-foreground" },
      { status: "done", count: 2, label: "Done", className: "text-success-foreground" },
      { status: "waiting", count: 1, label: "Waiting", className: "text-muted-foreground" },
    ]);
  });

  it("shows nothing on a quiet group or an open one, whose rows carry their own badges", () => {
    expect(resolveSidebarProjectGroupCounts({}, { open: false })).toEqual([]);
    expect(resolveSidebarProjectGroupCounts({ woke: 1 }, { open: true })).toEqual([]);
  });
});
