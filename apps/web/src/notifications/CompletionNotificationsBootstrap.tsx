import { useCompletionNotifications } from "./useCompletionNotifications";

/**
 * Mounts the global completion-notification watcher. Renders nothing; lives
 * near the other root-level bootstrap components so it runs for the entire
 * authenticated session regardless of the active route.
 */
export function CompletionNotificationsBootstrap(): null {
  useCompletionNotifications();
  return null;
}
