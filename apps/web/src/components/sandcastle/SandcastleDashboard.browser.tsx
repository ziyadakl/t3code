import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import type { PeerStatus, SandcastleStatusSnapshot } from "@t3tools/contracts";

const ENVIRONMENT_ID = "env-1" as never;
const PROJECT_ID = "proj-1";
const CWD = "/repo/project";
const NOW = "2026-07-15T12:00:00.000Z";

// vi.hoisted state the mock factories read; each test seeds these before render.
const { projectsRef, statusMapRef } = vi.hoisted(() => ({
  projectsRef: { current: [] as unknown[] },
  statusMapRef: { current: new Map<string, unknown>() },
}));

vi.mock("../../store.ts", () => ({
  selectProjectsAcrossEnvironments: () => projectsRef.current,
  // The component calls useStore(useShallow(selectProjectsAcrossEnvironments));
  // invoke the (shallow-wrapped) selector with a throwaway state so it returns
  // whatever selectProjectsAcrossEnvironments yields above.
  useStore: (selector: (state: unknown) => unknown) => selector({}),
}));

vi.mock("./useSandcastleStatuses.ts", () => ({
  statusKey: (environmentId: string, cwd: string) => `${environmentId}::${cwd}`,
  useSandcastleStatuses: () => statusMapRef.current,
}));

vi.mock("../../environments/runtime", () => ({
  useSavedEnvironmentRegistryStore: (selector: (state: unknown) => unknown) =>
    selector({ byId: {} }),
}));

vi.mock("../../uiStateStore.ts", () => ({
  useUiStateStore: (selector: (state: unknown) => unknown) =>
    selector({ sandcastleIdleCollapsed: false, toggleSandcastleIdleCollapsed: () => {} }),
}));

// Render <Link> as a plain anchor so no router context is required.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
}));

import { SandcastleDashboard } from "./SandcastleDashboard.tsx";

function snapshot(over: Partial<SandcastleStatusSnapshot>): SandcastleStatusSnapshot {
  return {
    schemaVersion: 3,
    state: "running",
    run: {
      branch: "main",
      repo: "o/r",
      startedAt: NOW,
      iterations: { current: 1, total: 9 },
      maxConcurrent: 1,
    },
    totals: { merged: 0, needsHuman: 0, requeued: 0, running: 0 },
    issues: [],
    updatedAt: NOW,
    ...over,
  };
}

function seed(snap: SandcastleStatusSnapshot) {
  projectsRef.current = [
    {
      environmentId: ENVIRONMENT_ID,
      id: PROJECT_ID,
      cwd: CWD,
      name: "My Project",
      repositoryIdentity: { owner: "o", name: "r" },
    },
  ];
  const map = new Map<string, unknown>();
  map.set(`${ENVIRONMENT_ID}::${CWD}`, {
    environmentId: ENVIRONMENT_ID,
    entry: {
      cwd: CWD,
      hasSandcastleDir: true,
      snapshot: snap,
      schemaOutdated: false,
      readError: null,
    },
    serverNow: NOW,
  });
  statusMapRef.current = map;
}

async function renderDashboard() {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(<SandcastleDashboard />, { container: host });
  return { host, screen };
}

describe("SandcastleDashboard cross-host totals fusion", () => {
  afterEach(() => {
    vi.clearAllMocks();
    projectsRef.current = [];
    statusMapRef.current = new Map();
    document.body.innerHTML = "";
  });

  it("renders the dashboard card counts as the cross-host sum, not own-only totals", async () => {
    const peer: PeerStatus = {
      hostId: "vps",
      state: "running",
      iterations: { current: 5, total: 9 },
      totals: { merged: 3, needsHuman: 0, requeued: 2, running: 1 },
      issues: [],
      updatedAt: NOW,
    };
    seed(
      snapshot({
        hostId: "mac",
        // Own-only totals: merged 4, running 1. Fused with the peer these become
        // merged 7, running 2 — values that do NOT appear on the own-only card.
        totals: { merged: 4, needsHuman: 1, requeued: 0, running: 1 },
        peers: [peer],
      }),
    );

    const { host, screen } = await renderDashboard();
    try {
      const text = document.body.textContent ?? "";

      // Fused merged total (4 own + 3 peer = 7) shows on the merged pill.
      expect(text).toContain("7");
      // Fused running total (1 own + 1 peer = 2) shows on the running pill.
      expect(text).toContain("2");

      // The own-only merged count (4) must NOT be what the card displays.
      expect(text).not.toContain("4");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
