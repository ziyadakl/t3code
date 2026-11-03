import {
  getProjectOrderKey,
  type ProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import type { SidebarProjectSortOrder } from "@t3tools/contracts/settings";

import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { legacyProjectCwdPreferenceKey } from "../../uiStateStore";
import { orderItemsByPreferredIds, sortSidebarV2ProjectGroups } from "../Sidebar.logic";

// The machine the sidebar is actually filtered to. A filter on a machine that
// is no longer in the saved machine list, or when only one machine is known,
// means "all machines". The persisted choice is left alone, so it applies again
// if that machine comes back.
export function resolveSidebarEnvironmentFilter(
  selectedEnvironmentId: EnvironmentId | null,
  knownEnvironmentIds: ReadonlyArray<EnvironmentId>,
): EnvironmentId | null {
  if (
    selectedEnvironmentId === null ||
    knownEnvironmentIds.length < 2 ||
    !knownEnvironmentIds.includes(selectedEnvironmentId)
  ) {
    return null;
  }
  return selectedEnvironmentId;
}

// Returns `items` itself when unfiltered so memoized consumers stay stable.
// `keep` lets an item on another machine through, e.g. the thread that is open.
export function filterToEnvironment<T extends { readonly environmentId: EnvironmentId }>(
  items: ReadonlyArray<T>,
  environmentId: EnvironmentId | null,
  keep?: (item: T) => boolean,
): ReadonlyArray<T> {
  if (environmentId === null) {
    return items;
  }
  return items.filter((item) => item.environmentId === environmentId || keep?.(item) === true);
}

// Search asks only connected servers: a query to one still connecting never
// settles, so a filtered machine that is offline searches nothing.
export function sidebarSearchEnvironmentIds(
  connectedEnvironmentIds: ReadonlyArray<EnvironmentId>,
  environmentFilterId: EnvironmentId | null,
): ReadonlyArray<EnvironmentId> {
  if (environmentFilterId === null) {
    return connectedEnvironmentIds;
  }
  return connectedEnvironmentIds.filter((id) => id === environmentFilterId);
}

// Whether a draft session gets a sidebar row under the project scope and
// machine filter. The open draft stays visible on any machine, like the open
// thread, so the filter never hides what the user is looking at.
export function isDraftSessionInSidebarScope(
  session: { readonly environmentId: EnvironmentId; readonly projectId: string },
  scope: {
    readonly scopedProjectKeys: ReadonlySet<string> | null;
    readonly environmentFilterId: EnvironmentId | null;
    readonly isRouteDraft: boolean;
  },
): boolean {
  if (
    scope.scopedProjectKeys !== null &&
    !scope.scopedProjectKeys.has(`${session.environmentId}:${session.projectId}`)
  ) {
    return false;
  }
  return (
    scope.environmentFilterId === null ||
    scope.isRouteDraft ||
    session.environmentId === scope.environmentFilterId
  );
}

// Label of the project scope trigger. A saved project scope that the machine
// filter hides is kept, not cleared, so the label says it is paused rather
// than reading like "All projects".
export function sidebarProjectScopeTriggerLabel(input: {
  readonly projectScopeKey: string | null;
  readonly scopedProjectName: string | null;
  readonly savedProjectName: string | null;
  readonly environmentFilterLabel: string | null;
}): string {
  if (input.scopedProjectName !== null) {
    return `Filter threads by project: ${input.scopedProjectName}`;
  }
  if (input.projectScopeKey !== null && input.environmentFilterLabel !== null) {
    return `Project filter paused: ${input.savedProjectName ?? "the saved project"} is not on ${input.environmentFilterLabel}`;
  }
  return "Filter threads by project";
}

/**
 * The project groups of one machine. A copy of the body of Upstream's
 * `hooks/useSidebarProjectGroups.ts`, run on that machine's projects and
 * threads only; that hook builds the groups for every machine. A sync should
 * diff this against it.
 */
export function buildEnvironmentProjectGroups(input: {
  /** Already narrowed to the machine. */
  readonly projects: ReadonlyArray<EnvironmentProject>;
  /** Already narrowed to the machine. */
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projectOrder: ReadonlyArray<string>;
  readonly sortOrder: SidebarProjectSortOrder;
  readonly groupingSettings: ProjectGroupingSettings;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly environmentLabelById: ReadonlyMap<EnvironmentId, string>;
  readonly delegatedUnderParent: ReadonlySet<string>;
}) {
  const { projects, sortOrder } = input;
  return sortSidebarV2ProjectGroups(
    buildSidebarProjectSnapshots({
      projects:
        sortOrder === "manual"
          ? orderItemsByPreferredIds({
              items: projects,
              preferredIds: input.projectOrder,
              getId: getProjectOrderKey,
              getPreferenceIds: (project) => [
                getProjectOrderKey(project),
                legacyProjectCwdPreferenceKey(project.workspaceRoot),
              ],
            })
          : projects,
      groupScratchProjects: true,
      settings: input.groupingSettings,
      primaryEnvironmentId: input.primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) =>
        input.environmentLabelById.get(environmentId) ?? null,
    }),
    input.threads,
    sortOrder,
    input.delegatedUnderParent,
  );
}
