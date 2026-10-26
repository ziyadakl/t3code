/**
 * Fork (grouped layout): the pure logic behind the sidebar's active list when
 * it is grouped by project. "Needs you" holds the threads whose status floats;
 * every other active thread sits in a foldable group for its project.
 */
import {
  buildLogicalProjectKeyLookup,
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveSidebarV2TopStatus,
  resolveThreadLastVisitedAt,
  type SidebarListItem,
  type SidebarV2TopStatusKind,
} from "../Sidebar.logic";
import { sortInboxThreadsByReturn } from "@t3tools/client-runtime/state/thread-inbox";
import { parseTimestampDate } from "../../timestampFormat";
import type { SidebarThreadSummary } from "../../types";

type ThreadStatusInput = Parameters<typeof hasUnseenCompletion>[0];
type SidebarThreadStatusInput = Parameters<typeof resolveSidebarThreadStatus>[0];
type LogicalProjectRef = Parameters<typeof buildLogicalProjectKeyLookup>[0][number];

export interface SidebarThreadAttention {
  readonly isUnread: boolean;
  readonly isWoke: boolean;
}

/** Unread and woke, for the sidebar row's badge and the grouped layout alike,
    so the layout floats and counts exactly what the badge shows. */
export function resolveSidebarThreadAttention(input: {
  readonly thread: ThreadStatusInput & {
    readonly settledOverride?: SidebarThreadSummary["settledOverride"] | undefined;
  };
  readonly localLastVisitedAt: string | undefined;
  readonly wokeAt: string | null;
}): SidebarThreadAttention {
  const lastVisitedAt = resolveThreadLastVisitedAt(
    input.thread.lastVisitedAt,
    input.localLastVisitedAt,
  );
  // An unparseable visit counts as never-visited, so corrupt local data
  // cannot eat the wake signal.
  const lastVisitedDate = lastVisitedAt === undefined ? null : parseTimestampDate(lastVisitedAt);
  const wokeAtDate = input.wokeAt === null ? null : parseTimestampDate(input.wokeAt);
  return {
    // Same semantics as the legacy sidebar (never-visited counts as read).
    isUnread: hasUnseenCompletion({ ...input.thread, lastVisitedAt }),
    isWoke:
      wokeAtDate !== null &&
      (lastVisitedDate === null || lastVisitedDate < wokeAtDate) &&
      input.thread.settledOverride !== "settled",
  };
}

export interface SidebarActiveProjectGroup<TThread> {
  /** Logical project key; null for the "No project" group. */
  readonly projectKey: string | null;
  readonly displayName: string;
  readonly threads: readonly TThread[];
  /** Threads inside the group (floating ones excluded) that still need the
      user, per top status: unread or woke, or waiting on an answer (input,
      approval). A read Failed, Limited or Waiting thread is not counted. */
  readonly statusCounts: Readonly<Partial<Record<SidebarV2TopStatusKind, number>>>;
}

export interface SidebarGroupedActiveModel<TThread> {
  readonly floating: readonly TThread[];
  readonly groups: readonly SidebarActiveProjectGroup<TThread>[];
}

/**
 * Splits the active (non-working) threads into the "Needs you" part and one
 * group per logical project. Everything is newest activity first, by the
 * inbox's return time: floating threads, each group's threads, and the
 * groups, ranked by the newest of all their threads, floating ones included.
 */
export function buildSidebarGroupedActiveModel<
  TThread extends SidebarThreadStatusInput &
    Parameters<typeof sortInboxThreadsByReturn>[0][number] & {
      readonly projectId: string;
    },
>(input: {
  readonly activeThreads: readonly TThread[];
  /** Returns the server does not stamp (see sortInboxThreadsByReturn). */
  readonly observedReturnAt?: (thread: TThread) => number | undefined;
  readonly projects: ReadonlyArray<
    LogicalProjectRef & {
      readonly displayName: string;
    }
  >;
  readonly floatStatuses: ReadonlySet<SidebarV2TopStatusKind>;
  readonly resolveAttention: (thread: TThread) => SidebarThreadAttention;
}): SidebarGroupedActiveModel<TThread> {
  const projectKeyOf = buildLogicalProjectKeyLookup(input.projects);
  const displayNameByKey = new Map(
    input.projects.map((project) => [project.projectKey, project.displayName]),
  );
  const floating: TThread[] = [];
  const groupsByKey = new Map<
    string | null,
    {
      projectKey: string | null;
      displayName: string;
      threads: TThread[];
      statusCounts: Partial<Record<SidebarV2TopStatusKind, number>>;
    }
  >();
  // A project ranks where its newest thread first appears.
  const rankByKey = new Map<string | null, number>();
  for (const thread of sortInboxThreadsByReturn(input.activeThreads, input.observedReturnAt)) {
    const projectKey = projectKeyOf(thread) ?? null;
    if (!rankByKey.has(projectKey)) rankByKey.set(projectKey, rankByKey.size);
    const attention = input.resolveAttention(thread);
    const topStatus = resolveSidebarV2TopStatus({
      status: resolveSidebarThreadStatus(thread),
      ...attention,
    });
    if (topStatus !== null && input.floatStatuses.has(topStatus)) {
      floating.push(thread);
      continue;
    }
    let group = groupsByKey.get(projectKey);
    if (!group) {
      group = {
        projectKey,
        displayName:
          (projectKey === null ? undefined : displayNameByKey.get(projectKey)) ?? "No project",
        threads: [],
        statusCounts: {},
      };
      groupsByKey.set(projectKey, group);
    }
    group.threads.push(thread);
    if (
      topStatus !== null &&
      (attention.isUnread || attention.isWoke || topStatus === "input" || topStatus === "approval")
    ) {
      group.statusCounts[topStatus] = (group.statusCounts[topStatus] ?? 0) + 1;
    }
  }
  const groups = [...groupsByKey.values()].sort(
    (left, right) => rankByKey.get(left.projectKey)! - rankByKey.get(right.projectKey)!,
  );
  return { floating, groups };
}

// A NUL byte never appears in a logical project key, so the "No project"
// group cannot share its fold state with a real project.
const NO_PROJECT_GROUP_FOLD_KEY = "\u0000no-project";

/** The key a project group's fold state is stored under. */
export function sidebarProjectGroupFoldKey(projectKey: string | null): string {
  return projectKey ?? NO_PROJECT_GROUP_FOLD_KEY;
}

/** The folded group a thread dropped into the inbox (from Settled or
    Snoozed) lands in, to open so the thread does not vanish; null when it
    floats to "Needs you" or its group is already open. */
export function sidebarProjectGroupToOpenOnDrop<
  TThread extends Parameters<typeof buildSidebarGroupedActiveModel>[0]["activeThreads"][number],
>(
  input: Omit<Parameters<typeof buildSidebarGroupedActiveModel<TThread>>[0], "activeThreads"> & {
    readonly thread: TThread;
    readonly openFoldKeys: readonly string[];
  },
): string | null {
  const [group] = buildSidebarGroupedActiveModel({
    ...input,
    activeThreads: [input.thread],
  }).groups;
  if (group === undefined) return null;
  const foldKey = sidebarProjectGroupFoldKey(group.projectKey);
  return input.openFoldKeys.includes(foldKey) ? null : foldKey;
}

/** Fold state is the list of open groups: a group not listed is folded.
    Toggling also drops saved keys that match none of `projectKeys`, so
    deleted projects do not pile up in storage. */
export function toggleSidebarProjectGroupOpen(
  openFoldKeys: readonly string[],
  foldKey: string,
  projectKeys: readonly string[],
): string[] {
  const live = new Set([NO_PROJECT_GROUP_FOLD_KEY, ...projectKeys.map(sidebarProjectGroupFoldKey)]);
  const kept = openFoldKeys.filter((key) => live.has(key) && key !== foldKey);
  return openFoldKeys.includes(foldKey) ? kept : [...kept, foldKey];
}

export type SidebarTopStatusIcon =
  | "working"
  | "waiting"
  | "approval"
  | "input"
  | "request"
  | "failed"
  | "woke"
  | "done";

/**
 * One table for how each top status reads: the row's badge, a group header's
 * counts, and the counts' order (most urgent first, the key order here).
 * Hues match the mobile Live Activity/widgets.
 */
export const SIDEBAR_TOP_STATUS_DISPLAY = {
  approval: { label: "Approval", icon: "approval", className: "text-warning-foreground" },
  input: { label: "Input", icon: "input", className: "text-indigo-600 dark:text-indigo-300" },
  // A guest is waiting on the owner.
  request: { label: "Request", icon: "request", className: "text-guest-foreground" },
  failed: { label: "Failed", icon: "failed", className: "text-error-foreground" },
  limited: { label: "Limited", icon: "failed", className: "text-warning-foreground" },
  woke: { label: "Woke", icon: "woke", className: "text-warning-foreground" },
  done: { label: "Done", icon: "done", className: "text-success-foreground" },
  // Waiting is calm background presence (post-settle background roster), not
  // active progress, so the label keeps full strength.
  waiting: { label: "Waiting", icon: "waiting", className: "text-muted-foreground" },
  // No shimmer: a label that animates forever is noise in a sidebar full of
  // them (and repaints every vsync on high-refresh displays).
  working: { label: "Working", icon: "working", className: "text-info-foreground" },
} as const satisfies Record<
  SidebarV2TopStatusKind,
  {
    readonly label: string;
    readonly icon: SidebarTopStatusIcon | null;
    readonly className: string;
  }
>;

// A guest request has no "Float to the top" setting, so it is not counted either.
export type SidebarCountedStatus = Exclude<SidebarV2TopStatusKind, "working" | "request">;

const PROJECT_GROUP_COUNT_ORDER = (
  Object.keys(SIDEBAR_TOP_STATUS_DISPLAY) as SidebarV2TopStatusKind[]
).filter((status): status is SidebarCountedStatus => status !== "working" && status !== "request");

/** The per-status counts a group header shows: only while folded, since an
    open group's rows carry their own badges. */
export function resolveSidebarProjectGroupCounts(
  statusCounts: Readonly<Partial<Record<SidebarV2TopStatusKind, number>>>,
  options: { readonly open: boolean },
): Array<{
  readonly status: SidebarCountedStatus;
  readonly count: number;
  readonly label: string;
  readonly className: string;
}> {
  if (options.open) return [];
  return PROJECT_GROUP_COUNT_ORDER.flatMap((status) => {
    const count = statusCounts[status] ?? 0;
    const { label, className } = SIDEBAR_TOP_STATUS_DISPLAY[status];
    return count > 0 ? [{ status, count, label, className }] : [];
  });
}

/**
 * The active section's rows in the grouped layout: "Needs you" and its rows,
 * then each group's header with its one-line rows when open. A folded group
 * keeps the open thread visible. `visibleThreads` is the rendered order.
 */
export function buildSidebarGroupedActiveRows<TThread>(input: {
  readonly model: SidebarGroupedActiveModel<TThread>;
  readonly openFoldKeys: readonly string[];
  readonly routeThreadKey: string | null;
  readonly threadKey: (thread: TThread) => string;
}): { readonly items: SidebarListItem[]; readonly visibleThreads: TThread[] } {
  const items: SidebarListItem[] = [{ kind: "marker", marker: "needs-you-header" }];
  const visibleThreads: TThread[] = [];
  for (const thread of input.model.floating) {
    items.push({ kind: "thread", key: input.threadKey(thread), section: "active" });
    visibleThreads.push(thread);
  }
  const openFoldKeys = new Set(input.openFoldKeys);
  for (const group of input.model.groups) {
    const foldKey = sidebarProjectGroupFoldKey(group.projectKey);
    const open = openFoldKeys.has(foldKey);
    items.push({
      kind: "marker",
      marker: "project-group",
      foldKey,
      open,
      projectKey: group.projectKey,
      displayName: group.displayName,
      statusCounts: group.statusCounts,
    });
    for (const thread of group.threads) {
      const key = input.threadKey(thread);
      if (!open && key !== input.routeThreadKey) continue;
      items.push({ kind: "thread", key, section: "active" });
      visibleThreads.push(thread);
    }
  }
  return { items, visibleThreads };
}
