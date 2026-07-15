import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import type {
  PeerStatus,
  SandcastleStatusHistoryEntry,
  SandcastleStatusIssue,
  SandcastleStatusSnapshot,
} from "@t3tools/contracts";

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

import { SandcastleProjectDetail } from "./SandcastleProjectDetail.tsx";

function issue(over: Partial<SandcastleStatusIssue> & { number: number }): SandcastleStatusIssue {
  return {
    title: `Issue ${over.number}`,
    branch: `sc/${over.number}`,
    phase: "implementer",
    ...over,
  };
}

function historyEntry(
  over: Partial<SandcastleStatusHistoryEntry> & { number: number },
): SandcastleStatusHistoryEntry {
  return {
    title: `History ${over.number}`,
    branch: `sc/${over.number}`,
    phase: "merged",
    completedAt: "2026-07-15T11:00:00.000Z",
    ...over,
  };
}

function snapshot(over: Partial<SandcastleStatusSnapshot>): SandcastleStatusSnapshot {
  return {
    schemaVersion: 3,
    state: "running",
    run: {
      branch: "main",
      repo: "o/r",
      startedAt: NOW,
      iterations: { current: 3, total: 8 },
      maxConcurrent: 1,
    },
    totals: { merged: 2, needsHuman: 1, requeued: 0, running: 1 },
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

async function renderDetail() {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <SandcastleProjectDetail
      environmentId={ENVIRONMENT_ID}
      projectId={PROJECT_ID}
      embedded
    />,
    { container: host },
  );
  return { host, screen };
}

describe("SandcastleProjectDetail cross-host fusion", () => {
  afterEach(() => {
    vi.clearAllMocks();
    projectsRef.current = [];
    statusMapRef.current = new Map();
    document.body.innerHTML = "";
  });

  it("fuses totals, per-machine iterations, active and recent across hosts", async () => {
    const peer: PeerStatus = {
      hostId: "vps",
      state: "running",
      iterations: { current: 5, total: 8 },
      totals: { merged: 3, needsHuman: 0, requeued: 1, running: 1 },
      issues: [
        issue({ number: 301, title: "Peer active", phase: "reviewer" }),
        issue({ number: 401, title: "Peer merged", phase: "merged" }),
      ],
      updatedAt: NOW,
    };
    seed(
      snapshot({
        hostId: "mac",
        issues: [issue({ number: 101, title: "Own active", phase: "implementer" })],
        history: [historyEntry({ number: 201, title: "Own merged", phase: "merged" })],
        totals: { merged: 2, needsHuman: 1, requeued: 0, running: 1 },
        peers: [peer],
      }),
    );

    const { host, screen } = await renderDetail();
    try {
      const text = document.body.textContent ?? "";

      // Combined merged total 2 (own) + 3 (peer) = 5 shows on the merged pill.
      expect(text).toContain("5 merged");

      // Per-machine iteration line names both hosts and their c/t.
      expect(text).toContain("Mac 3/8");
      expect(text).toContain("Vps 5/8");

      // Active list unions both hosts.
      expect(text).toContain("#101");
      expect(text).toContain("Own active");
      expect(text).toContain("#301");
      expect(text).toContain("Peer active");

      // Recent list unions finished issues from both hosts.
      expect(text).toContain("#201");
      expect(text).toContain("Own merged");
      expect(text).toContain("#401");
      expect(text).toContain("Peer merged");

      // Host badges tag rows in multi-host mode: each label appears beyond just
      // the iteration line (own gets one on its active row and one on its recent
      // row; likewise for the peer).
      const macCount = (text.match(/Mac/g) ?? []).length;
      const vpsCount = (text.match(/Vps/g) ?? []).length;
      expect(macCount).toBeGreaterThan(1);
      expect(vpsCount).toBeGreaterThan(1);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("renders a single-host (v2) snapshot with no host badges and a plain iteration line", async () => {
    seed(
      snapshot({
        // no hostId, no peers — a v2 file
        issues: [issue({ number: 101, title: "Only active", phase: "implementer" })],
        history: [historyEntry({ number: 201, title: "Only merged", phase: "merged" })],
        totals: { merged: 2, needsHuman: 1, requeued: 0, running: 1 },
      }),
    );

    const { host, screen } = await renderDetail();
    try {
      const text = document.body.textContent ?? "";

      // Plain iteration line, no host label.
      expect(text).toContain("3/8");
      expect(text).not.toContain("Mac");
      expect(text).not.toContain("Vps");

      // Own-only totals (unchanged from today).
      expect(text).toContain("2 merged");

      // Content still renders.
      expect(text).toContain("#101");
      expect(text).toContain("#201");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
