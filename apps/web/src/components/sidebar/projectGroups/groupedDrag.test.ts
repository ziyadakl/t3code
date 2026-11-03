import { describe, expect, it } from "vite-plus/test";
import type { SortingStrategy } from "@dnd-kit/sortable";
import { createSidebarSortingStrategy } from "../../Sidebar.drag";
import {
  sidebarListItemId,
  sidebarMarkerId,
  type SidebarListItem,
  type SidebarListMarker,
  type SidebarSection,
} from "../../Sidebar.logic";

const thread = (key: string, section: SidebarSection): SidebarListItem => ({
  kind: "thread",
  key,
  section,
});
const marker = (marker: SidebarListMarker): SidebarListItem => ({ kind: "marker", marker });
const pinnedHeader = marker("pinned-header");
const divider = marker("pinned-divider");
const settledHeader = marker("settled-header");
const stationary = { x: 0, y: 0, scaleX: 1, scaleY: 1 };

function layout(
  items: readonly SidebarListItem[],
  active: string,
  over: string,
  scale = 1,
  cardHeight = 82,
) {
  let top = 100;
  const rects = items.map((item) => {
    const height =
      item.kind === "thread"
        ? (item.section === "pinned" || item.section === "active" ? cardHeight : 36) * scale
        : item.marker === "pinned-header" || item.marker === "pinned-divider"
          ? 0
          : (item.marker.endsWith("placeholder") ? 0 : 32) * scale;
    const rect = { top, height, bottom: top + height, left: 0, right: 260, width: 260 };
    top += height + 1;
    return rect;
  });
  const activeIndex = items.findIndex((item) => sidebarListItemId(item) === active);
  return {
    activeIndex,
    overIndex: items.findIndex((item) => sidebarListItemId(item) === over),
    activeNodeRect: rects[activeIndex]!,
    rects,
    index: 0,
  } satisfies Parameters<SortingStrategy>[0];
}

function preview(
  input: Parameters<typeof createSidebarSortingStrategy>[0],
  active: string,
  over: string,
  scale = 1,
) {
  const strategy = createSidebarSortingStrategy(input);
  const args = layout(input.items, active, over, scale);
  return new Map(
    input.items.map((item, index) => [sidebarListItemId(item), strategy({ ...args, index })]),
  );
}

describe("grouped layout", () => {
  const groupHeader: SidebarListItem = {
    kind: "marker",
    marker: "project-group",
    foldKey: "alpha",
    open: true,
    projectKey: "alpha",
    displayName: "Alpha",
    statusCounts: {},
  };
  const groupHeaderId = sidebarListItemId(groupHeader);
  const items = [
    pinnedHeader,
    thread("p", "pinned"),
    divider,
    marker("needs-you-header"),
    thread("f", "active"),
    groupHeader,
    thread("a1", "active"),
    thread("a2", "active"),
    settledHeader,
    marker("settled-placeholder"),
  ];
  // Grouped, the inbox has no arrangeable order and no time order to project.
  const input = { items, settledOrder: [], settledExpanded: false, inboxArrangeable: false };

  it("keeps the group headers in place while a row inside a group moves within the inbox", () => {
    const result = preview(input, "a1", "a2");
    expect(result.get(sidebarMarkerId("needs-you-header"))).toEqual(stationary);
    expect(result.get(groupHeaderId)).toEqual(stationary);
    expect(result.get("a2")).toEqual(stationary);
  });

  it("closes the gap under a group header when its row leaves for Settled", () => {
    const result = preview(input, "a1", sidebarMarkerId("settled-placeholder"));
    expect(result.get(groupHeaderId)).toEqual(stationary);
    expect(result.get("a2")?.y).toBe(-83);
  });

  it("opens a gap under Needs you for an unpinned row, keeping the groups visible", () => {
    const result = preview(input, "p", "f");
    expect(result.get(sidebarMarkerId("needs-you-header"))?.scaleY).toBe(1);
    expect(result.get(groupHeaderId)?.scaleY).toBe(1);
    // f moves down by the arriving card, which the pinned slot no longer holds.
    expect(result.get("f")?.y).toBe(0);
  });
});
