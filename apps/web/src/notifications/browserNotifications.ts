/**
 * Thin DOM wrapper around the browser Notification API.
 *
 * Pure functions, no React. Safe to import in non-browser (SSR / test) contexts:
 * every entry point degrades gracefully when `window` or `Notification` is absent.
 */

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function getNotificationPermission(): NotificationPermission {
  if (!notificationsSupported()) {
    return "denied";
  }
  return window.Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!notificationsSupported()) {
    return "denied";
  }

  const { Notification } = window;

  // Avoid re-prompting once the user has already granted access.
  if (Notification.permission === "granted") {
    return "granted";
  }

  // The modern signature returns a Promise; some older browsers only support the
  // legacy callback form. Handle both without assuming either resolves.
  return await new Promise<NotificationPermission>((resolve) => {
    let settled = false;
    const settle = (permission: NotificationPermission) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(permission);
    };

    try {
      const maybePromise = Notification.requestPermission((permission) => {
        settle(permission);
      });
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(settle, () => settle("denied"));
      }
    } catch {
      settle("denied");
    }
  });
}

export interface CompletionNotificationOptions {
  title: string;
  body: string;
  /** Used as the Notification tag so repeats for one thread coalesce. */
  tag: string;
  onClick: () => void;
}

export function showCompletionNotification(opts: CompletionNotificationOptions): void {
  if (!notificationsSupported() || getNotificationPermission() !== "granted") {
    return;
  }

  try {
    const n = new window.Notification(opts.title, {
      body: opts.body,
      tag: opts.tag,
      silent: false,
    });
    n.addEventListener("click", () => {
      try {
        window.focus();
      } catch {
        // Some browsers disallow programmatic focus; ignore.
      }
      opts.onClick();
      n.close();
    });
  } catch {
    // Construction can throw outside a permitted context (e.g. some mobile
    // browsers, or when called without a user gesture). Swallow and no-op.
  }
}
