/**
 * Fork: the grouped layout of the sidebar's active list. "Needs you" labels
 * the floating rows, and each project group gets a foldable header in the
 * legacy sidebar's project header look. The rows themselves are the
 * sidebar's own thread rows; Sidebar.tsx places these pieces in its list.
 */
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import { resolveSidebarFloatToTopStatusSet } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";
import { FolderIcon, ChevronRightIcon } from "lucide-react";
import { Fragment } from "react";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useUiStateStore } from "../../uiStateStore";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import type { SidebarProjectGroupHeaderItem } from "../Sidebar.logic";
import { SidebarMenuButton } from "../ui/sidebar";
import {
  buildSidebarGroupedActiveModel,
  buildSidebarGroupedActiveRows,
  resolveSidebarProjectGroupCounts,
  resolveSidebarThreadAttention,
  sidebarProjectGroupToOpenOnDrop,
  toggleSidebarProjectGroupOpen,
  type SidebarCountedStatus,
} from "./projectGroups.logic";

// The fold keys of the project groups the user opened. A group not listed is
// folded, so new projects start folded.
const PROJECT_GROUPS_EXPANDED_KEY = "t3code:sidebar:project-groups-expanded";
const NO_OPEN_PROJECT_GROUPS: readonly string[] = [];
const OpenProjectGroupsSchema = Schema.Array(Schema.String);

type GroupedProject = Parameters<typeof buildSidebarGroupedActiveModel>[0]["projects"][number] &
  ProjectFaviconProject;

/**
 * The grouped layout's state for the sidebar: null when grouping is off.
 * `projects` must span every machine, so a thread kept visible from a
 * filtered-out machine still finds its project.
 */
export function useSidebarProjectGroups<TProject extends GroupedProject>(input: {
  readonly activeThreads: readonly EnvironmentThreadShell[];
  readonly projects: readonly TProject[];
  readonly routeThreadKey: string | null;
  readonly snoozeNow: string;
  readonly observedReturnAt?: (thread: EnvironmentThreadShell) => number | undefined;
}) {
  const { activeThreads, projects, routeThreadKey, snoozeNow, observedReturnAt } = input;
  const enabled = useClientSettings((s) => s.sidebarProjectGroupsEnabled);
  const floatToTopStatuses = useClientSettings((s) => s.sidebarFloatToTopStatuses);
  const threadLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const [openFoldKeys, setOpenFoldKeys] = useLocalStorage(
    PROJECT_GROUPS_EXPANDED_KEY,
    NO_OPEN_PROJECT_GROUPS,
    OpenProjectGroupsSchema,
  );
  const modelInput = {
    projects,
    // A status the contracts' "Float to the top" record lacks fails to compile here.
    floatStatuses: resolveSidebarFloatToTopStatusSet(
      floatToTopStatuses satisfies Record<SidebarCountedStatus, boolean>,
    ),
    resolveAttention: (thread: EnvironmentThreadShell) =>
      resolveSidebarThreadAttention({
        thread,
        localLastVisitedAt: threadLastVisitedAtById[threadKeyOf(thread)],
        wokeAt: threadWokeAt(thread, { now: snoozeNow }),
      }),
    ...(observedReturnAt === undefined ? {} : { observedReturnAt }),
  };
  let grouped = null;
  if (enabled) {
    const model = buildSidebarGroupedActiveModel({ ...modelInput, activeThreads });
    grouped = {
      model,
      ...buildSidebarGroupedActiveRows({
        model,
        openFoldKeys,
        routeThreadKey,
        threadKey: threadKeyOf,
      }),
    };
  }
  const projectKeys = projects.map((project) => project.projectKey);
  const toggleGroup = (foldKey: string) =>
    setOpenFoldKeys((keys) => toggleSidebarProjectGroupOpen(keys, foldKey, projectKeys));
  /** Opens the folded group a thread dropped into the inbox lands in. */
  const openGroupForDrop = (thread: EnvironmentThreadShell) => {
    if (!enabled) return;
    const foldKey = sidebarProjectGroupToOpenOnDrop({ ...modelInput, thread, openFoldKeys });
    if (foldKey !== null) toggleGroup(foldKey);
  };
  const projectByKey = new Map(projects.map((project) => [project.projectKey, project]));
  return { grouped, toggleGroup, openGroupForDrop, projectByKey };
}

function threadKeyOf(thread: Pick<EnvironmentThreadShell, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

export function SidebarNeedsYouHeader(props: { empty: boolean }) {
  return (
    <div data-testid="sidebar-needs-you-header">
      <div className="flex h-8 items-center gap-2 px-2 text-xs font-medium text-sidebar-muted-foreground/60">
        <span className="shrink-0">Needs you</span>
        <span aria-hidden className="h-px min-w-2 flex-1 bg-sidebar-border/60" />
      </div>
      {props.empty ? (
        <p className="px-2.5 pb-1.5 text-xs text-sidebar-muted-foreground/60">
          Nothing is waiting on you.
        </p>
      ) : null}
    </div>
  );
}

export function SidebarProjectGroupHeader(props: {
  header: SidebarProjectGroupHeaderItem;
  /** Null for the "No project" group, which shows a folder instead. */
  project: ProjectFaviconProject | null;
  onToggle: () => void;
}) {
  const { header } = props;
  const counts = resolveSidebarProjectGroupCounts(header.statusCounts, { open: header.open });
  return (
    <SidebarMenuButton
      aria-expanded={header.open}
      data-testid="sidebar-project-group-header"
      onClick={props.onToggle}
    >
      <ChevronRightIcon
        aria-hidden
        className={cn(
          "-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150",
          header.open && "rotate-90",
        )}
      />
      <span className="flex shrink-0">
        {props.project ? (
          <ProjectFavicon project={props.project} />
        ) : (
          <FolderIcon aria-hidden className="size-4 text-sidebar-muted-foreground" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground/90">
        {header.displayName}
      </span>
      {counts.length > 0 ? (
        <span className="flex shrink-0 items-center gap-1 text-xs font-medium tabular-nums">
          {counts.map((entry, index) => (
            <Fragment key={entry.status}>
              {index > 0 ? (
                <span aria-hidden className="text-sidebar-muted-foreground/50">
                  ·
                </span>
              ) : null}
              <span className={entry.className}>
                {entry.count} {entry.label}
              </span>
            </Fragment>
          ))}
        </span>
      ) : null}
    </SidebarMenuButton>
  );
}
