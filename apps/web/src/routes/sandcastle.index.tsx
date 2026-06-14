// apps/web/src/routes/sandcastle.index.tsx
import { createFileRoute } from "@tanstack/react-router";
import { SandcastleDashboard } from "../components/sandcastle/SandcastleDashboard.tsx";

export const Route = createFileRoute("/sandcastle/")({
  component: SandcastleDashboard,
});
