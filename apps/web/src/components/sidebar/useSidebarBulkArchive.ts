/**
 * "Archive (N)" in the sidebar's multi-select menu. `Sidebar.tsx` builds the
 * menu item with `prepare` and hands a click on it to `run`.
 */
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { ContextMenuItem } from "@t3tools/contracts";
import type { RefObject } from "react";

import { useThreadActions } from "../../hooks/useThreadActions";
import { useClientSettings } from "../../hooks/useSettings";
import { readLocalApi } from "../../localApi";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import type { SidebarThreadSummary } from "../../types";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  archiveThreadsAndReport,
  buildBulkArchiveContextMenuItem,
  refreshBulkArchiveTargets,
  resolveBulkArchiveCompletion,
} from "./bulkArchive.logic";

type ThreadOperationsCheck = (
  threads: readonly Pick<SidebarThreadSummary, "environmentId">[],
) => boolean;

export function useSidebarBulkArchive(input: {
  threadByKeyRef: RefObject<ReadonlyMap<string, SidebarThreadSummary>>;
  canOperateThreads: ThreadOperationsCheck;
  checkThreadOperations: ThreadOperationsCheck;
}) {
  const { threadByKeyRef, canOperateThreads, checkThreadOperations } = input;
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const { archiveThread } = useThreadActions();
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);

  return {
    /** Call once per menu open. */
    prepare(selectedThreads: readonly SidebarThreadSummary[]): {
      /** Disabled when no selected thread can be archived or the connection cannot operate on them. */
      menuItem: ContextMenuItem<"archive"> & { separatorBefore: true };
      /** Check, confirm, re-read the targets, check again, archive, report. */
      run: () => Promise<void>;
    } {
      const { item, targets: archivableThreads } = buildBulkArchiveContextMenuItem({
        threads: selectedThreads,
      });
      const currentThread = (thread: SidebarThreadSummary) =>
        threadByKeyRef.current.get(
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        );
      return {
        menuItem: {
          ...item,
          separatorBefore: true,
          disabled: item.disabled || !canOperateThreads(archivableThreads),
        },
        run: async () => {
          if (!checkThreadOperations(archivableThreads)) return;
          const api = readLocalApi();
          if (!api) return;
          if (confirmThreadArchive) {
            const confirmed = await settlePromise(() =>
              api.dialogs.confirm(
                `Archive ${archivableThreads.length} thread${archivableThreads.length === 1 ? "" : "s"}?`,
              ),
            );
            if (confirmed._tag === "Failure" || !confirmed.value) return;
          }
          const stillArchivable = refreshBulkArchiveTargets(archivableThreads, currentThread);
          if (!checkThreadOperations(stillArchivable)) return;
          await archiveThreadsAndReport({
            entries: stillArchivable.map((thread) => {
              const threadRef = scopeThreadRef(thread.environmentId, thread.id);
              return { threadKey: scopedThreadKey(threadRef), threadRef };
            }),
            archive: ({ threadRef }, onArchived) => archiveThread(threadRef, { onArchived }),
            reportError: (title, description) =>
              toastManager.add(stackedThreadToast({ type: "error", title, description })),
            removeFromSelection,
            onAllArchived: (archivedThreadKeys) => {
              const completion = resolveBulkArchiveCompletion({
                archivedThreadKeys,
                skippedCount: archivableThreads.length - stillArchivable.length,
              });
              if (completion.selection === "clear") {
                clearSelection();
                return;
              }
              removeFromSelection(archivedThreadKeys);
              toastManager.add(stackedThreadToast({ type: "warning", ...completion.notice }));
            },
          });
        },
      };
    },
  };
}
