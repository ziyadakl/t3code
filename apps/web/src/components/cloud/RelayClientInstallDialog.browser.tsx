import "../../index.css";

import { page } from "vitest/browser";
import { beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import {
  finishRelayClientInstall,
  reportRelayClientInstallProgress,
  requestRelayClientInstallConfirmation,
  resetRelayClientInstallDialogForTests,
} from "../../cloud/relayClientInstallDialog";
import { RelayClientInstallDialog } from "./RelayClientInstallDialog";

describe("RelayClientInstallDialog", () => {
  beforeEach(() => {
    resetRelayClientInstallDialogForTests();
  });

  it("confirms installation and renders streamed progress", async () => {
    render(<RelayClientInstallDialog />);
    const confirmation = requestRelayClientInstallConfirmation("2026.5.2");

    await expect.element(page.getByText("Install relay client?")).toBeInTheDocument();
    await expect.element(page.getByText(/version 2026\.5\.2 locally/)).toBeInTheDocument();

    await page.getByRole("button", { name: "Download and install" }).click();
    await expect(confirmation).resolves.toBe(true);
    await expect
      .element(page.getByRole("heading", { name: "Installing relay client" }))
      .toBeInTheDocument();

    reportRelayClientInstallProgress({ type: "progress", stage: "downloading" });
    await expect
      .element(page.getByText("Downloading relay client").first())
      .toHaveTextContent("Downloading relay client");
    await expect
      .element(page.getByText("Downloading relay client").first())
      .toHaveAttribute("class", expect.stringContaining("font-medium"));

    finishRelayClientInstall();
    await expect
      .element(page.getByRole("heading", { name: "Installing relay client" }))
      .not.toBeInTheDocument();
  });
});
