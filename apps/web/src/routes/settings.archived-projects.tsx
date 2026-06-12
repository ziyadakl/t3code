import { createFileRoute } from "@tanstack/react-router";

import { ArchivedProjectsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/archived-projects")({
  component: ArchivedProjectsPanel,
});
