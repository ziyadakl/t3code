import { useEffect, useState } from "react";

import type { EnvironmentId, ImportableSession } from "@t3tools/contracts";

import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { readEnvironmentApi } from "~/environmentApi";
import { useResumePickerStore } from "~/resumePickerStore";

interface ResumePickerProps {
  environmentId: EnvironmentId;
  /** The project's root working directory; the dir whose terminal sessions we list. */
  cwd: string | null;
}

type LoadStatus = "loading" | "ready" | "error";

/**
 * The `/resume` picker: lists past terminal Claude sessions for the current
 * project so they can be resumed inside t3. This is the deliberately minimal
 * first slice — it lists sessions; selecting one (the "import" action) is the
 * next slice. See repo CONTEXT.md + docs/adr/0001.
 */
export function ResumePicker({ environmentId, cwd }: ResumePickerProps) {
  const open = useResumePickerStore((store) => store.open);
  const setOpen = useResumePickerStore((store) => store.setOpen);

  const [sessions, setSessions] = useState<ReadonlyArray<ImportableSession>>([]);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    if (!cwd) {
      setStatus("error");
      setErrorDetail("No project directory is available for this thread.");
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      setStatus("error");
      setErrorDetail("This environment is not connected.");
      return;
    }

    let cancelled = false;
    setStatus("loading");
    setErrorDetail(null);
    api.resume
      .listImportableSessions({ cwd })
      .then((result) => {
        if (cancelled) {
          return;
        }
        setSessions(result.sessions);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setStatus("error");
        setErrorDetail(error instanceof Error ? error.message : String(error));
      });

    return () => {
      cancelled = true;
    };
  }, [open, cwd, environmentId]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Resume a terminal chat</DialogTitle>
          <DialogDescription>
            Past Claude sessions run in this project from the terminal.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-2">
          {status === "loading" ? (
            <div className="text-sm text-muted-foreground">Loading sessions…</div>
          ) : null}
          {status === "error" ? (
            <div className="text-sm text-destructive">{errorDetail}</div>
          ) : null}
          {status === "ready" && sessions.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No terminal sessions found for this project.
            </div>
          ) : null}
          {sessions.map((session) => (
            <div key={session.sessionId} className="rounded-md border px-3 py-2 text-sm">
              <div className="font-medium text-foreground">{session.title}</div>
              <div className="text-xs text-muted-foreground">
                {session.sessionId}
                {session.alreadyImported ? " · already imported" : ""}
              </div>
            </div>
          ))}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
