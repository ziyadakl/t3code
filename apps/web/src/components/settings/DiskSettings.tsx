import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  StorageOverview,
  StorageOverviewCategoryKey,
  StorageOverviewWorktree,
} from "@t3tools/contracts";
import { Trash2Icon } from "lucide-react";
import { useState } from "react";

import { formatBytes } from "../../lib/formatBytes";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";

const CATEGORY_LABELS: Readonly<Record<StorageOverviewCategoryKey, string>> = {
  worktrees: "Worktrees",
  runtime: "Runtime",
  database: "Database",
  logs: "Logs",
  other: "Other",
};

// Foreground at stepped opacities, so the bar follows the theme.
const SEGMENT_CLASSES = [
  "bg-foreground",
  "bg-foreground/70",
  "bg-foreground/45",
  "bg-foreground/25",
  "bg-foreground/12",
] as const;

function DiskBar({ overview }: { overview: StorageOverview }) {
  return (
    <div className="space-y-2.5 px-3 py-3 sm:px-4">
      <div
        role="img"
        aria-label="Disk use by category"
        className="flex h-1.5 gap-px overflow-hidden rounded-full bg-muted"
      >
        {overview.categories.map((category, index) => (
          <div
            key={category.key}
            className={SEGMENT_CLASSES[index] ?? SEGMENT_CLASSES[SEGMENT_CLASSES.length - 1]}
            style={{ width: `${(category.bytes / overview.totalBytes) * 100}%` }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {overview.categories.map((category, index) => (
          <li
            key={category.key}
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            <span
              aria-hidden
              className={cn(
                "size-2 shrink-0 rounded-full",
                SEGMENT_CLASSES[index] ?? SEGMENT_CLASSES[SEGMENT_CLASSES.length - 1],
              )}
            />
            {CATEGORY_LABELS[category.key]}
            <span className="tabular-nums text-foreground">{formatBytes(category.bytes)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function worktreeName(worktree: StorageOverviewWorktree) {
  return worktree.projectName ?? worktree.path.split(/[\\/]/).findLast(Boolean) ?? worktree.path;
}

function WorktreeRow({
  environmentId,
  worktree,
  onDelete,
}: {
  environmentId: EnvironmentId;
  worktree: StorageOverviewWorktree;
  onDelete: (worktree: StorageOverviewWorktree) => void;
}) {
  const canDelete = useAtomValue(
    serverEnvironment.removeStorageWorktree.permissionAtom(environmentId),
  );
  const name = worktreeName(worktree);
  return (
    <div className="px-3 py-2.5 sm:px-4">
      <div className="flex min-h-7 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{name}</span>
        <span className="shrink-0 text-sm tabular-nums text-foreground">
          {worktree.bytes === null ? "-" : formatBytes(worktree.bytes)}
        </span>
        {canDelete ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-destructive"
                  aria-label={`Delete worktree ${name}`}
                  onClick={() => onDelete(worktree)}
                >
                  <Trash2Icon />
                </Button>
              }
            />
            <TooltipPopup side="top">Delete worktree</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {worktree.threads.length > 0 ? (
        <ul className="mt-0.5 space-y-0.5 ps-3">
          {worktree.threads.map((thread) => (
            <li key={thread.threadId} className="min-w-0">
              <Link
                to="/$environmentId/$threadId"
                params={buildThreadRouteParams(scopeThreadRef(environmentId, thread.threadId))}
                className={cn(
                  "block truncate rounded-sm text-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  thread.archived ? "text-muted-foreground" : "text-foreground",
                )}
              >
                {thread.title}
              </Link>
            </li>
          ))}
        </ul>
      ) : worktree.branch !== null ? (
        <code className="mt-0.5 block truncate ps-3 text-xs text-muted-foreground">
          {worktree.branch}
        </code>
      ) : null}
    </div>
  );
}

/** Names only what survives: a detached worktree has no branch to keep. */
function WhatStays({ worktree }: { worktree: StorageOverviewWorktree }) {
  const hasThreads = worktree.threads.length > 0;
  const hasBranch = worktree.branch !== null;
  if (!hasThreads && !hasBranch) return null;
  return (
    <AlertDialogDescription>
      {hasThreads && hasBranch
        ? "Its threads and branch stay; a thread rebuilds the folder when you message it."
        : hasThreads
          ? "Its threads stay."
          : "Its branch stays."}
    </AlertDialogDescription>
  );
}

type DeleteAction = "delete" | "save";

function DeleteWorktreeDialog({
  worktree,
  canSaveChanges,
  pending,
  onCancel,
  onConfirm,
}: {
  worktree: StorageOverviewWorktree | null;
  canSaveChanges: boolean;
  pending: DeleteAction | null;
  onCancel: () => void;
  onConfirm: (worktree: StorageOverviewWorktree, action: DeleteAction) => void;
}) {
  // Keep the last worktree so the dialog does not change while it fades out.
  const [shown, setShown] = useState(worktree);
  if (worktree !== null && worktree !== shown) setShown(worktree);
  const uncommitted = shown?.uncommittedFiles ?? 0;
  const canSave = canSaveChanges && uncommitted > 0 && shown?.branch != null;
  return (
    <AlertDialog
      open={worktree !== null}
      onOpenChange={(open) => {
        if (!open && pending === null) onCancel();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete worktree?</AlertDialogTitle>
          {shown === null ? null : <WhatStays worktree={shown} />}
          {uncommitted > 0 ? (
            <p className="text-sm text-destructive">
              {canSave
                ? `Delete loses ${uncommitted} uncommitted ${uncommitted === 1 ? "file" : "files"}.`
                : `${uncommitted} uncommitted ${uncommitted === 1 ? "file" : "files"} will be lost.`}
            </p>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={pending !== null} />}>
            Cancel
          </AlertDialogClose>
          <Button
            variant="destructive"
            disabled={pending !== null || shown === null}
            onClick={() => shown !== null && onConfirm(shown, "delete")}
          >
            {pending === "delete" ? <Spinner /> : null}
            Delete
          </Button>
          {canSave ? (
            <Button
              disabled={pending !== null || shown === null}
              onClick={() => shown !== null && onConfirm(shown, "save")}
            >
              {pending === "save" ? <Spinner /> : null}
              Save &amp; delete
            </Button>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function MachineStorage({
  environmentId,
  heading,
}: {
  environmentId: EnvironmentId;
  heading: string | null;
}) {
  // The server caches for a minute; the refresh button asks it to measure again.
  const [forced, setForced] = useState(false);
  const { data, error, isPending, refresh } = useEnvironmentQuery(
    serverEnvironment.storageOverview({ environmentId, input: forced ? { refresh: true } : {} }),
  );
  const [target, setTarget] = useState<StorageOverviewWorktree | null>(null);
  const [deleting, setDeleting] = useState<DeleteAction | null>(null);
  const removeWorktree = useAtomCommand(serverEnvironment.removeStorageWorktree, {
    reportFailure: false,
  });

  const refreshNow = () => {
    if (forced) refresh();
    else setForced(true);
  };

  const confirmDelete = async (worktree: StorageOverviewWorktree, action: DeleteAction) => {
    setDeleting(action);
    const result = await removeWorktree({
      environmentId,
      input: {
        path: worktree.path,
        allowUncommittedFiles: worktree.uncommittedFiles,
        ...(action === "save" ? { saveChanges: true } : {}),
      },
    });
    setDeleting(null);
    if (result._tag === "Success") {
      setTarget(null);
      refresh();
    } else if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not delete worktree",
        description: failure instanceof Error ? failure.message : String(failure),
      });
      // The refusal usually means the list is out of date: close, and measure again.
      setTarget(null);
      refreshNow();
    }
  };

  return (
    <div className="space-y-8">
      {heading === null ? null : (
        <h2 className="truncate px-3 text-lg font-semibold text-foreground sm:px-4">{heading}</h2>
      )}
      <SettingsSection
        id="disk-overview"
        title="Disk"
        headerAction={
          <div className="flex items-center gap-2">
            {isPending ? (
              <Spinner size="sm" tone="muted" />
            ) : data !== null ? (
              <span className="text-sm tabular-nums text-foreground">
                {formatBytes(data.totalBytes)}
              </span>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label="Refresh"
                    disabled={isPending}
                    onClick={refreshNow}
                  >
                    <RefreshIcon refreshing={isPending} />
                  </Button>
                }
              />
              <TooltipPopup side="top">Refresh</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        {error !== null && data === null ? (
          <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">{error}</p>
        ) : data !== null && data.totalBytes > 0 ? (
          <DiskBar overview={data} />
        ) : null}
      </SettingsSection>
      {data === null ? null : (
        <SettingsSection id="disk-worktrees" title="Worktrees">
          {data.worktrees.length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">No worktrees</p>
          ) : (
            data.worktrees.map((worktree) => (
              <WorktreeRow
                key={worktree.path}
                environmentId={environmentId}
                worktree={worktree}
                onDelete={setTarget}
              />
            ))
          )}
        </SettingsSection>
      )}
      <DeleteWorktreeDialog
        worktree={target}
        canSaveChanges={data?.canSaveChanges === true}
        pending={deleting}
        onCancel={() => setTarget(null)}
        onConfirm={(worktree, action) => void confirmDelete(worktree, action)}
      />
    </div>
  );
}

export function DiskSettingsPanel() {
  const { connectedEnvironments } = useSettingsScope();
  const supported = connectedEnvironments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.storageOverview === true,
  );
  return (
    <SettingsPageContainer>
      {supported.map((environment) => (
        <MachineStorage
          key={environment.environmentId}
          environmentId={environment.environmentId}
          heading={
            supported.length > 1
              ? settingsScopeEnvironmentLabel(environment, connectedEnvironments)
              : null
          }
        />
      ))}
    </SettingsPageContainer>
  );
}
