/**
 * Maps the web sidebar's per-thread summary onto the platform-agnostic
 * {@link ThreadPhaseSnapshot} consumed by the notification reducer.
 *
 * The one load-bearing subtlety: `resolveThreadAwarenessPhase` expects the
 * orchestration session status, but on the web `ThreadSession.status` is a UI
 * phase. The orchestration status lives on `ThreadSession.orchestrationStatus`,
 * so that is the field we forward. Keeping this mapping in one tested place
 * prevents a future "simplification" to `session.status` from silently
 * computing the wrong phase.
 */
import type { AgentAwarenessPhase } from "@t3tools/shared/agentAwareness";
import { resolveThreadAwarenessPhase } from "@t3tools/shared/agentAwareness";

import type { SidebarThreadSummary } from "../types";
import type { ThreadPhaseSnapshot } from "./notificationReducer";

export function threadNotificationKey(environmentId: string, threadId: string): string {
  return `${environmentId}:${threadId}`;
}

/**
 * Phase consumed by the completion-notification reducer.
 *
 * Reuses the shared {@link resolveThreadAwarenessPhase} for pending approvals,
 * pending input, failures, and the active (starting/running) phases, then adds
 * one web-specific rule: a session that has settled to `"ready"` counts as
 * `"completed"`.
 *
 * Why the extra rule: the shared resolver only reports `"completed"` when
 * `latestTurn.state === "completed"`, but a finished turn frequently leaves
 * `latestTurn` null — the `thread.turn-diff-completed` / checkpoint event that
 * would populate it is not reliably emitted. The orchestration status, by
 * contrast, always transitions `"running"` -> `"ready"` when the agent finishes
 * a turn, so it is the dependable completion signal. The reducer only fires
 * `"completed"` on a transition out of an active phase, so idle / never-run
 * threads that surface as `"ready"` never produce a spurious notification.
 */
function resolveNotificationPhase(summary: SidebarThreadSummary): AgentAwarenessPhase | null {
  const base = resolveThreadAwarenessPhase({
    hasPendingApprovals: summary.hasPendingApprovals,
    hasPendingUserInput: summary.hasPendingUserInput,
    session: summary.session ? { status: summary.session.orchestrationStatus } : null,
    latestTurn: summary.latestTurn ? { state: summary.latestTurn.state } : null,
  });
  if (base !== null) {
    return base;
  }
  if (summary.session?.orchestrationStatus === "ready") {
    return "completed";
  }
  return null;
}

export function summaryToPhaseSnapshot(summary: SidebarThreadSummary): ThreadPhaseSnapshot {
  return {
    key: threadNotificationKey(summary.environmentId, summary.id),
    phase: resolveNotificationPhase(summary),
    title: summary.title,
    environmentId: summary.environmentId,
    threadId: summary.id,
  };
}
