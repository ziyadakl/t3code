/**
 * Watches every thread across every environment and raises a browser
 * notification when one transitions into a "done / needs me" phase
 * (completed, failed, waiting_for_approval, waiting_for_input).
 *
 * Behaviour (see the notification reducer for the precise rules):
 * - Edge-triggered: fires only on the transition into a notify phase, never
 *   repeatedly while a thread sits in it.
 * - No replay on load/reconnect: the first snapshot seeds each thread's phase
 *   silently, so already-finished threads never ping.
 * - Focus-suppressed: stays quiet only when the tab is focused AND you are
 *   viewing that exact thread.
 *
 * Works identically for a local browser and a remote (Tailscale) browser
 * because both consume the same live store stream.
 */
import { useParams, useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import type { AgentAwarenessPhase } from "@t3tools/shared/agentAwareness";

import { useSettings } from "../hooks/useSettings";
import { selectSidebarThreadsAcrossEnvironments, useStore } from "../store";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { showCompletionNotification } from "./browserNotifications";
import { computeNotifications } from "./notificationReducer";
import { summaryToPhaseSnapshot, threadNotificationKey } from "./threadSnapshot";

export function useCompletionNotifications(): void {
  const enabled = useSettings((settings) => settings.completionNotificationsEnabled);
  const router = useRouter();

  // The thread currently on screen, kept in a ref so the store subscription
  // (which runs outside React render) always reads the latest value.
  const routeTarget = useParams({ strict: false, select: (params) => resolveThreadRouteTarget(params) });
  const activeKeyRef = useRef<string | null>(null);
  activeKeyRef.current =
    routeTarget?.kind === "server"
      ? threadNotificationKey(routeTarget.threadRef.environmentId, routeTarget.threadRef.threadId)
      : null;

  const prevPhasesRef = useRef<Map<string, AgentAwarenessPhase | null>>(new Map());

  useEffect(() => {
    if (!enabled) {
      // Reset the baseline so a later re-enable re-seeds silently instead of
      // replaying every thread that finished while it was off.
      prevPhasesRef.current = new Map();
      return;
    }

    const run = (state: ReturnType<typeof useStore.getState>): void => {
      const snapshots = selectSidebarThreadsAcrossEnvironments(state).map(summaryToPhaseSnapshot);
      const isFocused =
        typeof document !== "undefined" &&
        document.visibilityState === "visible" &&
        document.hasFocus();

      const { next, toFire } = computeNotifications(prevPhasesRef.current, snapshots, {
        isFocused,
        activeKey: activeKeyRef.current,
      });
      prevPhasesRef.current = next;

      for (const fire of toFire) {
        showCompletionNotification({
          title: fire.title,
          body: fire.body,
          tag: fire.key,
          onClick: () => {
            void router.navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: fire.environmentId, threadId: fire.threadId },
            });
          },
        });
      }
    };

    // Seed silently from the current snapshot, then react to live changes.
    //
    // `run` fires on every store mutation (plain 1-arg subscribe, matching the
    // existing ChatView / uiStateStore subscribers). That's deliberately fine
    // here: the per-fire work is a cheap O(threads) pure pass, streamed tokens
    // are coalesced before they reach the store (~1 set() per message, not per
    // token), and the sidebar summary it reads is rewritten by the shell stream
    // behind an equality gate, so most streaming mutations don't change it at
    // all. If this ever becomes hot at very large thread counts, the escape
    // hatch is to wrap the store in `subscribeWithSelector` and subscribe with
    // `selectSidebarThreadsAcrossEnvironments` — but note that selector returns
    // a fresh array each call, so it would need a content equalityFn to dedupe.
    run(useStore.getState());
    return useStore.subscribe(run);
  }, [enabled, router]);
}
