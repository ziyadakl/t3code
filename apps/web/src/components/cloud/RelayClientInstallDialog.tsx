import { CircleCheckIcon, CircleIcon, DownloadIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import type { RelayClientInstallProgressStage } from "@t3tools/contracts";

import {
  readRelayClientInstallDialogState,
  respondToRelayClientInstallConfirmation,
  subscribeRelayClientInstallDialog,
} from "../../cloud/relayClientInstallDialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";

const installSteps: ReadonlyArray<{
  readonly stage: RelayClientInstallProgressStage;
  readonly label: string;
}> = [
  { stage: "checking", label: "Checking current installation" },
  { stage: "waiting_for_lock", label: "Waiting for installer" },
  { stage: "downloading", label: "Downloading relay client" },
  { stage: "verifying", label: "Verifying download" },
  { stage: "installing", label: "Installing relay client" },
  { stage: "validating", label: "Validating executable" },
  { stage: "activating", label: "Activating installation" },
];

export function RelayClientInstallDialog() {
  const state = useSyncExternalStore(
    subscribeRelayClientInstallDialog,
    readRelayClientInstallDialogState,
    readRelayClientInstallDialogState,
  );
  const isConfirming = state.status === "confirming";
  const isInstalling = state.status === "installing";
  const activeStepIndex = isInstalling
    ? installSteps.findIndex(({ stage }) => stage === state.stage)
    : -1;

  return (
    <Dialog
      open={state.status !== "idle"}
      onOpenChange={(open) => {
        if (!open && isConfirming) {
          respondToRelayClientInstallConfirmation(false);
        }
      }}
    >
      <DialogPopup className="max-w-md" showCloseButton={isConfirming}>
        <DialogHeader>
          <div className="flex size-9 items-center justify-center rounded-lg border border-border/70 bg-muted/60">
            <DownloadIcon aria-hidden className="size-4.5 text-muted-foreground" />
          </div>
          <DialogTitle>
            {isInstalling ? "Installing relay client" : "Install relay client?"}
          </DialogTitle>
          <DialogDescription>
            {isInstalling
              ? "T3 Code is preparing this environment for secure access through T3 Cloud."
              : "T3 Code needs the relay client to make this environment available through T3 Cloud."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel scrollFade={false}>
          {isInstalling ? (
            <ol aria-label="Relay client installation progress" className="space-y-2">
              {installSteps.map((step, index) => {
                const isComplete = activeStepIndex > index;
                const isActive = activeStepIndex === index;
                return (
                  <li
                    key={step.stage}
                    aria-current={isActive ? "step" : undefined}
                    className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm"
                  >
                    {isComplete ? (
                      <CircleCheckIcon aria-hidden className="size-4 text-success" />
                    ) : isActive ? (
                      <Spinner aria-hidden className="size-4 text-primary" />
                    ) : (
                      <CircleIcon aria-hidden className="size-4 text-muted-foreground/55" />
                    )}
                    <span
                      className={isActive ? "font-medium text-foreground" : "text-muted-foreground"}
                    >
                      {step.label}
                    </span>
                  </li>
                );
              })}
              <li aria-live="polite" className="sr-only">
                {activeStepIndex >= 0
                  ? installSteps[activeStepIndex]?.label
                  : "Starting installation"}
              </li>
            </ol>
          ) : (
            <div className="rounded-xl border border-border/70 bg-muted/35 p-3">
              <p className="text-sm font-medium text-foreground">Managed relay client</p>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                T3 Code will download and install version{" "}
                {state.status === "confirming" ? state.version : ""} locally.
              </p>
            </div>
          )}
        </DialogPanel>
        {isConfirming ? (
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => respondToRelayClientInstallConfirmation(false)}
            >
              Cancel
            </Button>
            <Button onClick={() => respondToRelayClientInstallConfirmation(true)}>
              Download and install
            </Button>
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
