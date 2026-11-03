/**
 * Fork (grouped layout): the list markers the grouped layout adds to the
 * sidebar's list. `Sidebar.logic.ts` unions these into its own marker types.
 * Kept apart from `projectGroups.logic.ts`, which imports from `Sidebar.logic`
 * at runtime, so the two never import each other's values.
 */
import type { SidebarV2TopStatusKind } from "../../Sidebar.logic";

/** The "Needs you" label above the floating rows. */
export type ProjectGroupsMarker = "needs-you-header";

/** A project group's header, carrying what it shows. */
export interface SidebarProjectGroupHeaderItem {
  readonly kind: "marker";
  readonly marker: "project-group";
  /** Where the group's fold state is stored; unique per group. */
  readonly foldKey: string;
  readonly open: boolean;
  /** Logical project key; null for the "No project" group. */
  readonly projectKey: string | null;
  readonly displayName: string;
  readonly statusCounts: Readonly<Partial<Record<SidebarV2TopStatusKind, number>>>;
}

// The same prefix `sidebarMarkerId` gives every other marker.
export function projectGroupListItemId(item: SidebarProjectGroupHeaderItem): string {
  return `sidebar-marker-project-group:${item.foldKey}`;
}
