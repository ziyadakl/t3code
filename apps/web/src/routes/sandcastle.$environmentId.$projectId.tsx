// apps/web/src/routes/sandcastle.$environmentId.$projectId.tsx
import { createFileRoute, useParams } from "@tanstack/react-router";
import { SandcastleProjectDetail } from "../components/sandcastle/SandcastleProjectDetail.tsx";

export const Route = createFileRoute("/sandcastle/$environmentId/$projectId")({
  component: function SandcastleDetailRoute() {
    const { environmentId, projectId } = useParams({
      from: "/sandcastle/$environmentId/$projectId",
    });
    return (
      <SandcastleProjectDetail
        environmentId={environmentId}
        projectId={projectId}
      />
    );
  },
});
