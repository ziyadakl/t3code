import { createFileRoute } from "@tanstack/react-router";
import { DiskSettingsPanel } from "../components/settings/DiskSettings";

export const Route = createFileRoute("/_chat/settings/disk")({
  component: DiskSettingsPanel,
});
