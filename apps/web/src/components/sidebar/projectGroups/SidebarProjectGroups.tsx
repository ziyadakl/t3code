/**
 * Fork: the grouped layout of the sidebar's active list. "Needs you" labels
 * the floating rows, and each project group gets a foldable header in the
 * legacy sidebar's project header look. The rows themselves are the
 * sidebar's own thread rows; Sidebar.tsx places these pieces in its list.
 */
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import { resolveSidebarFloatToTopStatusSet } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";
import { FolderIcon, ChevronRightIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { useLocalStorage } from "../../../hooks/useLocalStorage";
import { useClientSettings } from "../../../hooks/useSettings";
import { cn } from "../../../lib/utils";
import { useUiStateStore } from "../../../uiStateStore";
import { ProjectFavicon, type ProjectFaviconProject } from "../../ProjectFavicon";
import {
  animateSidebarLayoutChanges,
  sidebarListItemId,
  sidebarMarkerId,
  type SidebarListItem,
} from "../../Sidebar.logic";
import { SidebarMenuButton } from "../../ui/sidebar";
import { SIDEBAR_SORTABLE_DRAG_DISABLED } from "../SidebarThreadRow";
import type { SidebarProjectGroupHeaderItem } from "./projectGroupMarker";
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
export function useSidebarInboxGroups<TProject extends GroupedProject>(input: {
  readonly activeThreads: readonly EnvironmentThreadShell[];
  readonly projects: readonly TProject[];
  readonly routeThreadKey: string | null;
  readonly snoozeNow: string;
  readonly observedReturnAt?: (thread: EnvironmentThreadShell) => number | undefined;
  readonly workingShelfEnabled: boolean;
  /** Upstream's boring-mode folders are on: they take precedence. */
  readonly suppressed: boolean;
}) {
  const { activeThreads, projects, routeThreadKey, snoozeNow, observedReturnAt } = input;
  const enabled = useClientSettings((s) => s.sidebarProjectGroupsEnabled) && !input.suppressed;
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
  // The inbox keeps a user-arranged order only while it is neither time-ordered
  // (Working beta) nor grouped by project, where rows hold places.
  const inboxArrangeable = !input.workingShelfEnabled && grouped === null;
  return {
    grouped,
    toggleGroup,
    openGroupForDrop,
    projectByKey,
    inboxArrangeable,
    activeTimeOrdered: !inboxArrangeable,
    // Grouped, the inbox has no flat order for a dragged row to land in.
    flatTimeOrdered: input.workingShelfEnabled && grouped === null,
    /** The active threads in keyboard order. Folded group rows don't render,
        so they leave keyboard order and jump hints. */
    orderedActive: grouped?.visibleThreads ?? activeThreads,
    /** The active section's list items; null when the list is flat. */
    activeRows: grouped?.items ?? null,
  };
}

type SidebarProjectGroupsLayout = ReturnType<typeof useSidebarInboxGroups>;

/** A group marker's place in the sortable list; it never drags. */
function SortableGroupMarker(props: { id: string; children: ReactNode }) {
  const { setNodeRef, transform, transition } = useSortable({
    id: props.id,
    disabled: SIDEBAR_SORTABLE_DRAG_DISABLED,
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  return (
    <li
      ref={setNodeRef}
      data-thread-selection-safe
      className="list-none"
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        visibility: transform?.scaleY === 0 ? "hidden" : undefined,
      }}
    >
      {props.children}
    </li>
  );
}

/**
 * The node for a marker the grouped layout owns ("Needs you" and a project
 * group's header), or null for any other marker.
 */
export function renderProjectGroupMarker(
  item: Extract<SidebarListItem, { kind: "marker" }>,
  layout: SidebarProjectGroupsLayout,
): ReactNode | null {
  if (item.marker === "project-group") {
    const { foldKey, projectKey } = item;
    return (
      <SortableGroupMarker key={sidebarListItemId(item)} id={sidebarListItemId(item)}>
        <SidebarProjectGroupHeader
          header={item}
          project={projectKey === null ? null : (layout.projectByKey.get(projectKey) ?? null)}
          onToggle={() => layout.toggleGroup(foldKey)}
        />
      </SortableGroupMarker>
    );
  }
  if (item.marker === "needs-you-header") {
    return (
      <SortableGroupMarker key={item.marker} id={sidebarMarkerId(item.marker)}>
        <SidebarNeedsYouHeader empty={(layout.grouped?.model.floating.length ?? 0) === 0} />
      </SortableGroupMarker>
    );
  }
  return null;
}

function threadKeyOf(thread: Pick<EnvironmentThreadShell, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

function SidebarNeedsYouHeader(props: { empty: boolean }) {
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

function SidebarProjectGroupHeader(props: {
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
