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
import { resolveThreadAwarenessPhase } from "@t3tools/shared/agentAwareness";

import type { SidebarThreadSummary } from "../types";
import type { ThreadPhaseSnapshot } from "./notificationReducer";

export function threadNotificationKey(environmentId: string, threadId: string): string {
  return `${environmentId}:${threadId}`;
}

export function summaryToPhaseSnapshot(summary: SidebarThreadSummary): ThreadPhaseSnapshot {
  const phase = resolveThreadAwarenessPhase({
    hasPendingApprovals: summary.hasPendingApprovals,
    hasPendingUserInput: summary.hasPendingUserInput,
    session: summary.session ? { status: summary.session.orchestrationStatus } : null,
    latestTurn: summary.latestTurn ? { state: summary.latestTurn.state } : null,
  });

  return {
    key: threadNotificationKey(summary.environmentId, summary.id),
    phase,
    title: summary.title,
    environmentId: summary.environmentId,
    threadId: summary.id,
  };
}
