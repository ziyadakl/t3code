// apps/web/src/routes/sandcastle.tsx
import { createFileRoute, redirect, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/sandcastle")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: () => <Outlet />,
});
