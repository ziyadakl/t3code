/**
 * Fork: the grouped layout of the sidebar's active list. "Needs you" labels
 * the floating rows, and each project group gets a foldable header in the
 * legacy sidebar's project header look. The rows themselves are the
 * sidebar's own thread rows; Sidebar.tsx places these pieces in its list.
 */
import { FolderIcon, ChevronRightIcon } from "lucide-react";
import { Fragment } from "react";
import { cn } from "../../lib/utils";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { resolveSidebarProjectGroupCounts } from "../Sidebar.logic";
import { SidebarMenuButton } from "../ui/sidebar";

// The same hues as the row's status badge, so a count reads as the badge it stands for.
const COUNT_CLASS_NAME: Record<
  ReturnType<typeof resolveSidebarProjectGroupCounts>[number]["status"],
  string
> = {
  approval: "text-warning-foreground",
  input: "text-indigo-600 dark:text-indigo-300",
  failed: "text-error",
  limited: "text-warning",
  woke: "text-warning",
  done: "text-success",
  waiting: "text-muted-foreground",
};

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
  displayName: string;
  /** Null for the "No project" group, which shows a folder instead. */
  project: ProjectFaviconProject | null;
  open: boolean;
  statusCounts: Parameters<typeof resolveSidebarProjectGroupCounts>[0];
  onToggle: () => void;
}) {
  const counts = resolveSidebarProjectGroupCounts(props.statusCounts, { open: props.open });
  return (
    <SidebarMenuButton
      aria-expanded={props.open}
      data-testid="sidebar-project-group-header"
      onClick={props.onToggle}
    >
      <ChevronRightIcon
        aria-hidden
        className={cn(
          "-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150",
          props.open && "rotate-90",
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
        {props.displayName}
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
              <span className={COUNT_CLASS_NAME[entry.status]}>
                {entry.count} {entry.label}
              </span>
            </Fragment>
          ))}
        </span>
      ) : null}
    </SidebarMenuButton>
  );
}
