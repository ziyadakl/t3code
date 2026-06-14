import { type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ChevronDownIcon, Globe, Loader2Icon } from "lucide-react";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { readEnvironmentApi } from "~/environmentApi";
import { readLocalApi } from "~/localApi";

interface DevServerToggleProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  worktreePath: string | null;
  projectCwd: string | null;
}

/** Debounce delay for status re-fetch on window focus / visibility change (ms). */
const STATUS_REFRESH_DEBOUNCE_MS = 500;

export const DevServerToggle = memo(function DevServerToggle({
  environmentId,
  threadId,
  worktreePath,
  projectCwd,
}: DevServerToggleProps) {
  const [running, setRunning] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const unmountedRef = useRef(false);

  // Whether we have an active project context to run a dev server against.
  const available = worktreePath !== null || projectCwd !== null;

  const payload = { threadId, worktreePath, projectCwd };

  // Seed state from server on mount and when the thread/worktree changes.
  useEffect(() => {
    unmountedRef.current = false;
    const api = readEnvironmentApi(environmentId);
    if (!api || !available) return;

    void api.devServer.status(payload).then((status) => {
      if (unmountedRef.current) return;
      setRunning(status.running);
      setUrl(status.url);
    });

    return () => {
      unmountedRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environmentId, threadId, worktreePath, projectCwd, available]);

  // Keep status honest: re-fetch when the user returns to the tab or the window
  // regains focus, debounced to avoid rapid-fire fetches.
  useEffect(() => {
    if (!available) return;

    let refreshTimeout: number | null = null;

    const scheduleRefreshStatus = () => {
      if (refreshTimeout !== null) {
        window.clearTimeout(refreshTimeout);
      }
      refreshTimeout = window.setTimeout(() => {
        refreshTimeout = null;
        const api = readEnvironmentApi(environmentId);
        if (!api || unmountedRef.current) return;
        void api.devServer.status(payload).then((status) => {
          if (unmountedRef.current) return;
          setRunning(status.running);
          setUrl(status.url);
        });
      }, STATUS_REFRESH_DEBOUNCE_MS);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        scheduleRefreshStatus();
      }
    };

    window.addEventListener("focus", scheduleRefreshStatus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      if (refreshTimeout !== null) {
        window.clearTimeout(refreshTimeout);
      }
      window.removeEventListener("focus", scheduleRefreshStatus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environmentId, threadId, worktreePath, projectCwd, available]);

  /** Open the given URL (or no-op if null). */
  const openUrl = useCallback((targetUrl: string) => {
    const localApi = readLocalApi();
    if (!localApi) return;
    void localApi.shell.openExternal(targetUrl).catch((err: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open dev server URL",
          description: err instanceof Error ? err.message : "An error occurred.",
        }),
      );
    });
  }, []);

  /** Primary Globe button: open when running, start when stopped. */
  const handlePrimaryClick = useCallback(async () => {
    const api = readEnvironmentApi(environmentId);
    if (!api || pending) return;

    if (running) {
      if (url) {
        // Server is running and URL is known — open it directly. No server call.
        openUrl(url);
        return;
      }
      // Running but URL not yet in state — re-fetch once and open if available.
      const status = await api.devServer.status(payload).catch(() => null);
      if (unmountedRef.current) return;
      if (status) {
        setRunning(status.running);
        setUrl(status.url);
        if (status.url) openUrl(status.url);
      }
      return;
    }

    // Not running → start.
    setPending(true);
    try {
      const status = await api.devServer.start(payload);
      if (unmountedRef.current) return;
      setRunning(status.running);
      setUrl(status.url);
      if (status.url) openUrl(status.url);
    } catch (err: unknown) {
      if (unmountedRef.current) return;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to start dev server",
          description: err instanceof Error ? err.message : "An unexpected error occurred.",
        }),
      );
    } finally {
      if (!unmountedRef.current) setPending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environmentId, threadId, worktreePath, projectCwd, running, url, pending, openUrl]);

  /** Stop the dev server. */
  const handleStop = useCallback(async () => {
    const api = readEnvironmentApi(environmentId);
    if (!api || pending) return;

    setPending(true);
    try {
      const status = await api.devServer.stop(payload);
      if (unmountedRef.current) return;
      setRunning(status.running);
      setUrl(status.url);
    } catch (err: unknown) {
      if (unmountedRef.current) return;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to stop dev server",
          description: err instanceof Error ? err.message : "An unexpected error occurred.",
        }),
      );
    } finally {
      if (!unmountedRef.current) setPending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environmentId, threadId, worktreePath, projectCwd, pending]);

  /** Restart: stop then start, then open the new URL. */
  const handleRestart = useCallback(async () => {
    const api = readEnvironmentApi(environmentId);
    if (!api || pending) return;

    setPending(true);
    try {
      await api.devServer.stop(payload);
      if (unmountedRef.current) return;
      const status = await api.devServer.start(payload);
      if (unmountedRef.current) return;
      setRunning(status.running);
      setUrl(status.url);
      if (status.url) openUrl(status.url);
    } catch (err: unknown) {
      if (unmountedRef.current) return;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to restart dev server",
          description: err instanceof Error ? err.message : "An unexpected error occurred.",
        }),
      );
    } finally {
      if (!unmountedRef.current) setPending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environmentId, threadId, worktreePath, projectCwd, pending, openUrl]);

  const primaryLabel = running
    ? url
      ? `Open dev server (${url})`
      : "Dev server running"
    : "Start dev server";

  const tooltipText = !available
    ? "Dev server needs an active project."
    : pending
      ? running
        ? "Stopping dev server…"
        : "Starting dev server…"
      : running
        ? url
          ? `Dev server running at ${url}`
          : "Dev server running"
        : "Start dev server";

  return (
    <Group aria-label="Dev server controls" className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={primaryLabel}
              aria-pressed={running}
              data-pressed={running ? "" : undefined}
              disabled={!available || pending}
              onClick={() => {
                void handlePrimaryClick();
              }}
              size="xs"
              variant="outline"
            >
              {pending ? (
                <Loader2Icon className="size-3 animate-spin" />
              ) : (
                <Globe className="size-3" />
              )}
            </Button>
          }
        />
        <TooltipPopup side="bottom">{tooltipText}</TooltipPopup>
      </Tooltip>

      <GroupSeparator />

      <Menu>
        <MenuTrigger
          render={
            <Button
              aria-label="Dev server options"
              disabled={!available || pending}
              size="icon-xs"
              variant="outline"
            />
          }
        >
          <ChevronDownIcon aria-hidden="true" className="size-3" />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem
            disabled={!running || pending}
            onClick={() => {
              void handleStop();
            }}
          >
            Stop
          </MenuItem>
          <MenuItem
            disabled={!running || pending}
            onClick={() => {
              void handleRestart();
            }}
          >
            Restart
          </MenuItem>
        </MenuPopup>
      </Menu>
    </Group>
  );
});
