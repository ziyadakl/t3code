import { type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Globe, Loader2Icon } from "lucide-react";
import { Toggle } from "../ui/toggle";
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

  const handleToggle = useCallback(async () => {
    const api = readEnvironmentApi(environmentId);
    if (!api || pending) return;

    setPending(true);
    try {
      if (running) {
        // Stop the dev server.
        const status = await api.devServer.stop(payload);
        if (unmountedRef.current) return;
        setRunning(status.running);
        setUrl(status.url);
      } else {
        // Start the dev server — can take up to ~60s.
        const status = await api.devServer.start(payload);
        if (unmountedRef.current) return;
        setRunning(status.running);
        setUrl(status.url);
        // Open the URL in the user's browser once it's ready.
        if (status.url) {
          const localApi = readLocalApi();
          if (localApi) {
            void localApi.shell.openExternal(status.url).catch((err: unknown) => {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Unable to open dev server URL",
                  description: err instanceof Error ? err.message : "An error occurred.",
                }),
              );
            });
          }
        }
      }
    } catch (err: unknown) {
      if (unmountedRef.current) return;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: running ? "Failed to stop dev server" : "Failed to start dev server",
          description: err instanceof Error ? err.message : "An unexpected error occurred.",
        }),
      );
      // Leave toggle in its pre-action state (don't flip running).
    } finally {
      if (!unmountedRef.current) {
        setPending(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environmentId, threadId, worktreePath, projectCwd, running, pending]);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0"
            pressed={running}
            onPressedChange={() => {
              void handleToggle();
            }}
            aria-label={running ? "Stop dev server" : "Start dev server"}
            variant="outline"
            size="xs"
            disabled={!available || pending}
          >
            {pending ? (
              <Loader2Icon className="size-3 animate-spin" />
            ) : (
              <Globe className="size-3" />
            )}
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">
        {!available
          ? "Dev server needs an active project."
          : pending
            ? running
              ? "Stopping dev server…"
              : "Starting dev server…"
            : running
              ? url
                ? `Dev server running at ${url}`
                : "Stop dev server"
              : "Start dev server"}
      </TooltipPopup>
    </Tooltip>
  );
});
