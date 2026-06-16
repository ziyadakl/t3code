import type { AgentAwarenessPhase } from "@t3tools/shared/agentAwareness";
import { headlineForPhase } from "@t3tools/shared/agentAwareness";

/**
 * Phases that warrant a completion notification when a thread transitions into
 * them. Active/transient phases ("starting", "running", "stale") never notify.
 */
const NOTIFY_PHASES: ReadonlySet<AgentAwarenessPhase> = new Set([
  "completed",
  "failed",
  "waiting_for_approval",
  "waiting_for_input",
]);

export interface ThreadPhaseSnapshot {
  /** Stable identity for the thread: `${environmentId}:${threadId}`. */
  key: string;
  phase: AgentAwarenessPhase | null;
  /** Thread title — becomes the notification body text. */
  title: string;
  environmentId: string;
  threadId: string;
}

export interface FireSpec {
  key: string;
  phase: AgentAwarenessPhase;
  /** Headline from {@link headlineForPhase} — the notification TITLE. */
  title: string;
  /** Thread title — the notification BODY. */
  body: string;
  environmentId: string;
  threadId: string;
}

export interface NotificationContext {
  /** Document is visible AND the window currently has focus. */
  isFocused: boolean;
  /** Key of the thread currently being viewed, or null if none. */
  activeKey: string | null;
}

/**
 * Pure transition reducer: given the previously observed phase per thread, the
 * current snapshots, and focus context, decide which completion notifications
 * to fire and return the updated phase map.
 *
 * Newly seen keys are seeded silently (no fire) so initial load and reconnect
 * re-snapshots never produce a burst of stale notifications.
 */
export function computeNotifications(
  prev: ReadonlyMap<string, AgentAwarenessPhase | null>,
  current: readonly ThreadPhaseSnapshot[],
  ctx: NotificationContext,
): { next: Map<string, AgentAwarenessPhase | null>; toFire: FireSpec[] } {
  const next = new Map<string, AgentAwarenessPhase | null>(prev);
  const toFire: FireSpec[] = [];

  for (const s of current) {
    // First time we have ever seen this thread: seed silently. Covers initial
    // load, reconnect re-snapshots, and threads first observed already-terminal.
    if (!prev.has(s.key)) {
      next.set(s.key, s.phase);
      continue;
    }

    const previous = prev.get(s.key) ?? null;
    next.set(s.key, s.phase);

    if (s.phase === null) {
      continue;
    }

    const changed = s.phase !== previous;
    const isNotifyPhase = NOTIFY_PHASES.has(s.phase);
    const suppressedByFocus = ctx.isFocused && ctx.activeKey === s.key;

    if (changed && isNotifyPhase && !suppressedByFocus) {
      toFire.push({
        key: s.key,
        phase: s.phase,
        title: headlineForPhase(s.phase),
        body: s.title,
        environmentId: s.environmentId,
        threadId: s.threadId,
      });
    }
  }

  return { next, toFire };
}
