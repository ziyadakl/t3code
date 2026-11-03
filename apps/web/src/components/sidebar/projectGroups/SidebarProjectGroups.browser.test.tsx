import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../../test/render";
import { sidebarListItemId, type SidebarListItem } from "../../Sidebar.logic";
import { SidebarProvider } from "../../ui/sidebar";
import { renderProjectGroupMarker } from "./SidebarProjectGroups";

type Layout = Parameters<typeof renderProjectGroupMarker>[1];

const groupHeader = {
  kind: "marker",
  marker: "project-group",
  foldKey: "alpha",
  open: false,
  projectKey: null,
  displayName: "Alpha",
  statusCounts: { done: 2, input: 1 },
} satisfies SidebarListItem;
const needsYou = { kind: "marker", marker: "needs-you-header" } satisfies SidebarListItem;
const settledHeader = { kind: "marker", marker: "settled-header" } satisfies SidebarListItem;

function renderMarkers(layout: Pick<Layout, "toggleGroup" | "projectByKey" | "grouped">) {
  const items = [needsYou, groupHeader, settledHeader] as const;
  return render(
    <SidebarProvider>
      <DndContext>
        <SortableContext items={items.map(sidebarListItemId)}>
          <ul>{items.map((item) => renderProjectGroupMarker(item, layout as Layout) ?? null)}</ul>
        </SortableContext>
      </DndContext>
    </SidebarProvider>,
    { router: false },
  );
}

describe("renderProjectGroupMarker", () => {
  it("draws Needs you and a folded group's per-status counts, and toggles on click", async () => {
    const toggleGroup = vi.fn();
    await using _screen = await renderMarkers({
      toggleGroup,
      projectByKey: new Map(),
      grouped: { model: { floating: [], groups: [] }, items: [], visibleThreads: [] },
    });

    await expect.element(page.getByTestId("sidebar-needs-you-header")).toBeVisible();
    await expect.element(page.getByText("Nothing is waiting on you.")).toBeVisible();
    const header = page.getByTestId("sidebar-project-group-header");
    // Most urgent status first.
    await expect.element(header).toHaveTextContent("Alpha1 Input·2 Done");

    await userEvent.click(header);
    expect(toggleGroup).toHaveBeenCalledWith("alpha");
  });

  it("leaves every other marker to the sidebar", () => {
    expect(renderProjectGroupMarker(settledHeader, {} as Layout)).toBeNull();
  });
});
