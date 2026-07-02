import "../../index.css";

import { page } from "vite-plus/test/browser";
import { describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

function renderActions(props: { isRunning: boolean; runningSubagentCount: number }) {
  return render(
    <ComposerPrimaryActions
      compact={false}
      pendingAction={null}
      isRunning={props.isRunning}
      runningSubagentCount={props.runningSubagentCount}
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

describe("ComposerPrimaryActions running subagent count", () => {
  it("shows '{n} running' while running with live subagents", async () => {
    renderActions({ isRunning: true, runningSubagentCount: 2 });
    await expect.element(page.getByText("2 running")).toBeVisible();
  });

  it("hides the count while running when no subagents are live", async () => {
    renderActions({ isRunning: true, runningSubagentCount: 0 });
    // The stop button is still present, but no running-count label is rendered.
    await expect.element(page.getByLabelText("Stop generation")).toBeVisible();
    expect(page.getByText("running").query()).toBeNull();
  });

  it("hides the count when the turn is not running", () => {
    renderActions({ isRunning: false, runningSubagentCount: 3 });
    expect(page.getByText("running").query()).toBeNull();
  });
});
