import "../../index.css";

import { page } from "vite-plus/test/browser";
import { describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import type { RunningSubagentRow } from "../../hooks/useRunningSubagentTree";

function renderActions(props: { isRunning: boolean; runningSubagents: RunningSubagentRow[] }) {
  return render(
    <ComposerPrimaryActions
      compact={false}
      pendingAction={null}
      isRunning={props.isRunning}
      runningSubagents={props.runningSubagents}
      showPlanFollowUpPrompt={false}
      promptHasText={false}
      isSendBusy={false}
      isConnecting={false}
      isEnvironmentUnavailable={false}
      isPreparingWorktree={false}
      hasSendableContent={false}
      onPreviousPendingQuestion={() => {}}
      onInterrupt={() => {}}
      onImplementPlanInNewThread={() => {}}
    />,
  );
}

describe("ComposerPrimaryActions nested subagent rows", () => {
  it("renders one row per running top-level subagent with (+N) descendants", async () => {
    renderActions({
      isRunning: true,
      runningSubagents: [
        { toolUseId: "orch-1", subagentType: "orchestrator", descendantCount: 4 },
        { toolUseId: "exp-1", subagentType: "Explore", descendantCount: 0 },
      ],
    });
    await expect.element(page.getByText("subagent: orchestrator (+4)")).toBeVisible();
    await expect.element(page.getByText("subagent: Explore")).toBeVisible();
  });

  it("keys each row by its toolUseId so same-type siblings stay stable (F3)", async () => {
    renderActions({
      isRunning: true,
      runningSubagents: [
        { toolUseId: "a-1", subagentType: "Explore", descendantCount: 2 },
        { toolUseId: "a-2", subagentType: "Explore", descendantCount: 0 },
      ],
    });
    // Two same-type rows: identity must come from toolUseId, not (type:index), so the
    // (+2) row is tied to a-1 and the plain row to a-2 (they don't collide on key).
    await expect
      .element(page.getByText("subagent: Explore (+2)"))
      .toHaveAttribute("data-subagent-tool-use-id", "a-1");
    const rowA2 = document.querySelector('[data-subagent-tool-use-id="a-2"]');
    expect(rowA2?.textContent).toBe("subagent: Explore");
  });

  it("shows no rows while running when no subagents are live", async () => {
    renderActions({ isRunning: true, runningSubagents: [] });
    await expect.element(page.getByLabelText("Stop generation")).toBeVisible();
    expect(page.getByText(/^subagent:/).query()).toBeNull();
  });

  it("shows no rows when the turn is not running", () => {
    renderActions({
      isRunning: false,
      runningSubagents: [{ toolUseId: "exp-1", subagentType: "Explore", descendantCount: 0 }],
    });
    expect(page.getByText(/^subagent:/).query()).toBeNull();
  });
});
