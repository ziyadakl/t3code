import { type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { RightPanelSheet } from "../RightPanelSheet";
import { Button } from "../ui/button";
import { readEnvironmentApi } from "~/environmentApi";

/** How often to re-read the logfile tail while the panel is open (ms). */
const POLL_MS = 1500;

interface DevServerLogsPanelProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  worktreePath: string | null;
  projectCwd: string | null;
  onClose: () => void;
}

/**
 * Right-side panel that shows a dev server's log by polling `devServer.logs`.
 * Polling (rather than streaming) keeps this self-contained: it just re-reads
 * the on-disk logfile t3 already writes. Also surfaces the file path so the user
 * can `tail -f` it from a terminal.
 */
export function DevServerLogsPanel({
  environmentId,
  threadId,
  worktreePath,
  projectCwd,
  onClose,
}: DevServerLogsPanelProps) {
  const [content, setContent] = useState("");
  const [logPath, setLogPath] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  // Only auto-scroll if the user is already pinned to the bottom.
  const atBottomRef = useRef(true);

  useEffect(() => {
    let cancelled = false;
    const api = readEnvironmentApi(environmentId);
    if (!api) return;
    const payload = { threadId, worktreePath, projectCwd };

    const poll = () => {
      void api.devServer
        .logs(payload)
        .then((res) => {
          if (cancelled) return;
          setContent(res.content);
          setLogPath(res.logPath);
        })
        .catch(() => undefined);
    };

    poll();
    const id = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [environmentId, threadId, worktreePath, projectCwd]);

  // Keep the view pinned to the newest output when the user is at the bottom.
  useEffect(() => {
    const el = preRef.current;
    if (el && atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [content]);

  const copyPath = useCallback(() => {
    if (!logPath) return;
    void navigator.clipboard
      ?.writeText(logPath)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_200);
      })
      .catch(() => undefined);
  }, [logPath]);

  return (
    <RightPanelSheet open onClose={onClose}>
      <div className="flex h-full flex-col gap-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium text-sm">Dev server logs</h2>
          <Button onClick={onClose} size="xs" variant="outline">
            Close
          </Button>
        </div>

        {logPath ? (
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/60">
              {logPath}
            </span>
            <Button onClick={copyPath} size="xs" variant="outline">
              {copied ? "Copied" : "Copy path"}
            </Button>
          </div>
        ) : null}

        <pre
          className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all rounded-md border border-input p-2 font-mono text-[11px] leading-snug"
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          ref={preRef}
        >
          {content ||
            "No logs yet. Only dev servers started by t3 are logged — use the Globe (or ▾ Restart) to start one."}
        </pre>
      </div>
    </RightPanelSheet>
  );
}
