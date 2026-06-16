import { describe, expect, it } from "vite-plus/test";

import type {
  EnvironmentId,
  OrchestrationLatestTurn,
  OrchestrationLatestTurnState,
  OrchestrationSessionStatus,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import type { SidebarThreadSummary, ThreadSession } from "../types";
import { summaryToPhaseSnapshot, threadNotificationKey } from "./threadSnapshot";

const ISO = "2026-01-01T00:00:00.000Z";

function makeSession(orchestrationStatus: OrchestrationSessionStatus): ThreadSession {
  // Deliberately set the UI `status` to "error" while the orchestration status
  // is healthy: if the mapping ever regresses to reading `.status`, the phase
  // would wrongly become "failed" and these tests would catch it.
  return {
    provider: "claude-code",
    status: "error",
    createdAt: ISO,
    updatedAt: ISO,
    orchestrationStatus,
  } as ThreadSession;
}

function makeLatestTurn(state: OrchestrationLatestTurnState): OrchestrationLatestTurn {
  return {
    turnId: "turn-1",
    state,
    requestedAt: ISO,
    startedAt: null,
    completedAt: null,
    assistantMessageId: null,
  } as OrchestrationLatestTurn;
}

function makeSummary(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: "thread-1" as ThreadId,
    environmentId: "env-1" as EnvironmentId,
    projectId: "proj-1" as ProjectId,
    title: "Build the thing",
    interactionMode: "default",
    session: null,
    createdAt: ISO,
    archivedAt: null,
    updatedAt: ISO,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("summaryToPhaseSnapshot", () => {
  it("derives the phase from orchestrationStatus, not the UI status field", () => {
    const snapshot = summaryToPhaseSnapshot(makeSummary({ session: makeSession("running") }));
    expect(snapshot.phase).toBe("running");
  });

  it("reports completed when the latest turn completed", () => {
    const snapshot = summaryToPhaseSnapshot(makeSummary({ latestTurn: makeLatestTurn("completed") }));
    expect(snapshot.phase).toBe("completed");
  });

  it("reports completed when the session settled to ready even with a null latest turn", () => {
    // The real shape of a finished turn in this orchestrator: the session goes
    // "ready" but latestTurn stays null because the turn-diff/checkpoint event
    // that would populate it is not reliably emitted. This MUST still resolve to
    // "completed" or the agent finishing never fires a notification.
    const snapshot = summaryToPhaseSnapshot(makeSummary({ session: makeSession("ready") }));
    expect(snapshot.phase).toBe("completed");
  });

  it("does not report completed for an idle session with no turn", () => {
    const snapshot = summaryToPhaseSnapshot(makeSummary({ session: makeSession("idle") }));
    expect(snapshot.phase).toBeNull();
  });

  it("does not report completed for a stopped session with no turn", () => {
    const snapshot = summaryToPhaseSnapshot(makeSummary({ session: makeSession("stopped") }));
    expect(snapshot.phase).toBeNull();
  });

  it("reports waiting_for_approval when approvals are pending", () => {
    const snapshot = summaryToPhaseSnapshot(makeSummary({ hasPendingApprovals: true }));
    expect(snapshot.phase).toBe("waiting_for_approval");
  });

  it("reports waiting_for_input when user input is pending", () => {
    const snapshot = summaryToPhaseSnapshot(makeSummary({ hasPendingUserInput: true }));
    expect(snapshot.phase).toBe("waiting_for_input");
  });

  it("reports failed when the orchestration session errored", () => {
    const snapshot = summaryToPhaseSnapshot(makeSummary({ session: makeSession("error") }));
    expect(snapshot.phase).toBe("failed");
  });

  it("returns a null phase for an idle thread with no session or turn", () => {
    const snapshot = summaryToPhaseSnapshot(makeSummary());
    expect(snapshot.phase).toBeNull();
  });

  it("forwards key, title, and ids", () => {
    const snapshot = summaryToPhaseSnapshot(makeSummary());
    expect(snapshot.key).toBe(threadNotificationKey("env-1", "thread-1"));
    expect(snapshot.key).toBe("env-1:thread-1");
    expect(snapshot.title).toBe("Build the thing");
    expect(snapshot.environmentId).toBe("env-1");
    expect(snapshot.threadId).toBe("thread-1");
  });
});
