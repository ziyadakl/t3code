/**
 * The sidebar machine filter, as two hooks `Sidebar.tsx` calls. The filter
 * narrows the whole sidebar to one environment: filtering the roots means
 * project groups, the scope picker, shelves and search all follow.
 */
import { withoutArchivedProjects } from "@t3tools/client-runtime/state/archived-projects";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, type ReactNode } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  useEnvironmentIdentities,
  useEnvironmentMachines,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { useDelegatedUnderParent, useProjects, useQuietThreadShells } from "../../state/entities";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { useUiStateStore } from "../../uiStateStore";
import {
  buildEnvironmentProjectGroups,
  filterToEnvironment,
  resolveSidebarEnvironmentFilter,
  sidebarProjectScopeTriggerLabel,
  sidebarSearchEnvironmentIds,
} from "./environmentFilter.logic";
import { useEnvironmentFilterStore } from "./environmentFilterStore";
import { SidebarEnvironmentFilter } from "./SidebarEnvironmentFilter";

type EnvironmentIdentities = ReturnType<typeof useEnvironmentIdentities>;

/**
 * Called in the sidebar's lookups. Reads the projects and threads, drops archived
 * projects and their threads, then narrows to the filtered machine, in that order.
 * Returns every machine's projects and threads too (the open thread or draft stays
 * listed on any machine and still needs its project's icon and name).
 */
export function useSidebarEnvironmentFilter(input: {
  /** Every machine's project groups. */
  allProjectGroups: ReadonlyArray<SidebarProjectSnapshot>;
  environments: EnvironmentIdentities;
  environmentLabelById: ReadonlyMap<EnvironmentId, string>;
}): {
  allProjects: ReadonlyArray<EnvironmentProject>;
  allThreads: ReadonlyArray<EnvironmentThreadShell>;
  /** The machine the sidebar is filtered to; null means all machines. */
  environmentFilterId: EnvironmentId | null;
  projects: ReadonlyArray<EnvironmentProject>;
  projectGroups: ReadonlyArray<SidebarProjectSnapshot>;
} {
  const { allProjectGroups, environments, environmentLabelById } = input;
  // Quiet threads: see useSidebarProjectGroups.
  const { projects: allProjects, threads: allThreads } = withoutArchivedProjects(
    useProjects(),
    useQuietThreadShells(),
  );
  const selectedEnvironmentId = useEnvironmentFilterStore((store) => store.selectedEnvironmentId);
  const delegatedUnderParent = useDelegatedUnderParent();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const sortOrder = useClientSettings((s) => s.sidebarProjectSortOrder);
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // A saved choice for a machine that is gone (or a single-machine catalog)
  // resolves to all machines without clearing it.
  const environmentFilterId = resolveSidebarEnvironmentFilter(
    selectedEnvironmentId,
    environments.map((environment) => environment.environmentId),
  );
  const projects = filterToEnvironment(allProjects, environmentFilterId);
  // Filtered, the groups are rebuilt from that machine's projects only.
  const projectGroups =
    environmentFilterId === null
      ? allProjectGroups
      : buildEnvironmentProjectGroups({
          projects,
          threads: filterToEnvironment(allThreads, environmentFilterId),
          projectOrder,
          sortOrder,
          groupingSettings,
          primaryEnvironmentId,
          environmentLabelById,
          delegatedUnderParent,
        });
  return { allProjects, allThreads, environmentFilterId, projects, projectGroups };
}

// Outlined call to action under a sidebar empty-state message.
function ShowAllMachinesButton(props: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-2xs font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
    >
      Show all machines
    </button>
  );
}

/**
 * Called in the sidebar body: the header control, the labels and empty states
 * the filter changes, and the pieces of the list it narrows.
 */
export function useSidebarEnvironmentFilterUi(input: {
  environmentFilterId: EnvironmentId | null;
  environmentLabelById: ReadonlyMap<EnvironmentId, string>;
  allProjectGroups: ReadonlyArray<SidebarProjectSnapshot>;
  projectScopeKeys: ReadonlyArray<string>;
}) {
  const { environmentFilterId, environmentLabelById, allProjectGroups, projectScopeKeys } = input;
  const environments = useEnvironmentIdentities();
  const machineByEnvironmentId = useEnvironmentMachines();
  const setSelectedEnvironmentId = useEnvironmentFilterStore(
    (store) => store.setSelectedEnvironmentId,
  );
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const label =
    environmentFilterId === null
      ? null
      : (environmentLabelById.get(environmentFilterId) ?? "this machine");

  // Scope flips drop the selection: rows selected under the old scope may be
  // hidden now, and bulk actions must never count or touch invisible rows.
  const projectScopeKey = projectScopeKeys.length === 0 ? null : projectScopeKeys.join("\n");
  const scopeSignature = JSON.stringify([environmentFilterId, projectScopeKey]);
  const clearedScopeSignatureRef = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the thread selection when the machine filter or project scope changes
  useEffect(() => {
    if (clearedScopeSignatureRef.current === scopeSignature) return;
    clearedScopeSignatureRef.current = scopeSignature;
    clearSelection();
  }, [clearSelection, scopeSignature, clearedScopeSignatureRef]);

  const showAllMachines = () => setSelectedEnvironmentId(null);
  return {
    /** The filtered machine's name, or null when unfiltered. */
    label,
    /** The header menu; absent with one machine. */
    headerControl:
      environments.length > 1 ? (
        <SidebarEnvironmentFilter
          environments={environments}
          machineByEnvironmentId={machineByEnvironmentId}
          selectedEnvironmentId={environmentFilterId}
          onSelect={setSelectedEnvironmentId}
        />
      ) : null,
    /** The open thread stays listed on any machine so the filter never hides what the user is looking at. */
    visibleThreads(
      allThreads: ReadonlyArray<EnvironmentThreadShell>,
      route: { threadKey: string | null; rowThreadKey: string | null },
    ): ReadonlyArray<EnvironmentThreadShell> {
      return filterToEnvironment(allThreads, environmentFilterId, (thread) => {
        if (route.threadKey === null) return false;
        const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
        return key === route.threadKey || key === route.rowThreadKey;
      });
    },
    /** Filtered to one machine, only that machine's server is asked, and only while it is connected. */
    searchEnvironmentIds: (connectedEnvironmentIds: ReadonlyArray<EnvironmentId>) =>
      sidebarSearchEnvironmentIds(connectedEnvironmentIds, environmentFilterId),
    /** The project-scope trigger's label; says so when the machine filter pauses a saved project scope. */
    scopeTriggerLabel(scopedProjectGroups: ReadonlyArray<{ readonly displayName: string }>) {
      return sidebarProjectScopeTriggerLabel({
        projectScopeKey,
        scopedProjectName:
          scopedProjectGroups.length > 0
            ? scopedProjectGroups.map((project) => project.displayName).join(", ")
            : null,
        savedProjectName:
          allProjectGroups
            .filter((group) => projectScopeKeys.includes(group.projectKey))
            .map((group) => group.displayName)
            .join(", ") || null,
        environmentFilterLabel: label,
      });
    },
    /** Replaces the search list's empty message while filtered; null when unfiltered. */
    searchEmptyState(isPending: boolean): ReactNode | null {
      if (label === null) return null;
      return (
        <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs">
          <p role="status" className="text-sidebar-muted-foreground">
            {isPending ? "Searching thread messages…" : `No threads found on ${label}`}
          </p>
          {isPending ? null : <ShowAllMachinesButton onClick={showAllMachines} />}
        </div>
      );
    },
    /** Content for the thread list's empty message while filtered; null when unfiltered. */
    listEmptyState(
      scopedProjectGroups: ReadonlyArray<{ readonly displayName: string }>,
    ): ReactNode | null {
      if (label === null) return null;
      return (
        <>
          <span>
            {scopedProjectGroups.length > 1
              ? `No threads in these projects on ${label}`
              : scopedProjectGroups[0]
                ? `No threads in ${scopedProjectGroups[0].displayName} on ${label}`
                : `No threads on ${label}`}
          </span>
          <ShowAllMachinesButton onClick={showAllMachines} />
        </>
      );
    },
  };
}
