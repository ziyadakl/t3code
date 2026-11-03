/**
 * Fork (grouped layout): how a drag previews the sidebar's active list while
 * it is grouped by project. `createSidebarSortingStrategy` in `Sidebar.drag.ts`
 * calls these.
 */
import type { SidebarListItem, SidebarSection } from "../../Sidebar.logic";

type ThreadItem = Extract<SidebarListItem, { kind: "thread" }>;

const isGroupedInboxMarker = (item: SidebarListItem) =>
  item.kind === "marker" && (item.marker === "needs-you-header" || item.marker === "project-group");

/** Rows sitting under a project group header: one-line rows. */
export function groupedRowKeys(items: readonly SidebarListItem[]): ReadonlySet<string> {
  const keys = new Set<string>();
  let underGroup = false;
  for (const item of items) {
    if (item.kind === "marker") underGroup = item.marker === "project-group";
    else if (underGroup) keys.add(item.key);
  }
  return keys;
}

/**
 * The inbox has no order to preview, so its headers and rows hold their
 * places. A row leaving closes its gap; an arriving row opens one under
 * "Needs you".
 */
export function projectGroupedInbox(
  items: readonly SidebarListItem[],
  active: ThreadItem,
  target: { readonly section: SidebarSection },
): SidebarListItem[] {
  const inbox: SidebarListItem[] = [];
  for (const item of items) {
    if (item.kind === "marker" ? isGroupedInboxMarker(item) : item.section === "active") {
      if (item.kind === "thread" && item.key === active.key && target.section !== "active")
        continue;
      inbox.push(item);
      if (
        item.kind === "marker" &&
        item.marker === "needs-you-header" &&
        active.section !== "active" &&
        target.section === "active"
      )
        inbox.push({ ...active, section: "active" });
    }
  }
  if (!inbox.some((item) => item.kind === "thread")) {
    inbox.unshift({ kind: "marker", marker: "active-placeholder" });
  }
  return inbox;
}
