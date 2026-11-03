import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../../test/render";
import { TooltipProvider } from "../../ui/tooltip";
import { CompactRowSlot } from "./rowQuickActions";

function renderSlot(overrides: Partial<Parameters<typeof CompactRowSlot>[0]>) {
  const onSettle = vi.fn();
  const onDiscardDraft = vi.fn();
  const screen = render(
    <TooltipProvider>
      <div data-testid="row" className="group/sidebar-row p-4">
        <CompactRowSlot
          variantAction="settle"
          settlementSupported
          snoozeSupported
          canSnoozeNow={false}
          hasUnsentDraft={false}
          snoozeMenuOpen={false}
          onSnoozeMenuOpenChange={() => {}}
          onSnooze={() => {}}
          timestampFormat="locale"
          environmentId={EnvironmentId.make("environment-local")}
          onDiscardDraft={onDiscardDraft}
          onSettle={onSettle}
          onActionPointerDown={() => {}}
          {...overrides}
        />
      </div>
    </TooltipProvider>,
    { router: false },
  );
  return { screen, onSettle, onDiscardDraft };
}

describe("CompactRowSlot", () => {
  it("offers discard draft and settle, and settle runs on click", async () => {
    const { screen, onSettle, onDiscardDraft } = renderSlot({ hasUnsentDraft: true });
    await using _screen = await screen;

    await expect.element(page.getByLabelText("Discard draft")).toBeInTheDocument();
    await expect.element(page.getByLabelText("Settle thread")).toBeInTheDocument();
    // Hidden at rest; hovering the row brings the actions in.
    await userEvent.hover(page.getByTestId("row"));
    await userEvent.click(page.getByLabelText("Settle thread"));
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(onDiscardDraft).not.toHaveBeenCalled();
  });

  it("offers nothing when the thread cannot be settled", async () => {
    const { screen } = renderSlot({ settlementSupported: false });
    await using _screen = await screen;

    await expect.element(page.getByLabelText("Settle thread")).not.toBeInTheDocument();
  });
});
