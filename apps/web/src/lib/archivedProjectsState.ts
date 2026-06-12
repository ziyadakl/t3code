import { useAtomValue } from "@effect/atom-react";
import {
  type ArchivedSnapshotEntry,
  createArchivedThreadsManager,
  makeArchivedThreadsEnvironmentKey,
  readArchivedThreadsSnapshotState,
} from "@t3tools/client-runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { readEnvironmentApi } from "../environmentApi";
import { appAtomRegistry } from "../rpc/atomRegistry";

// Reuses the shared archived-snapshot manager, but adapts the per-environment
// client so it loads the archived *projects* snapshot. Archived projects are
// feed-excluded from the active shell, so the settings panel reads them through
// this dedicated query just like archived threads.
const archivedProjectsManager = createArchivedThreadsManager({
  getRegistry: () => appAtomRegistry,
  getClient: (environmentId) => {
    const orchestration = readEnvironmentApi(environmentId)?.orchestration;
    if (!orchestration) {
      return null;
    }
    return {
      getArchivedShellSnapshot: orchestration.getArchivedProjectsSnapshot,
    };
  },
});

export function refreshArchivedProjectsForEnvironment(environmentId: EnvironmentId): void {
  archivedProjectsManager.refreshForEnvironment(environmentId);
}

export function useArchivedProjectSnapshots(environmentIds: ReadonlyArray<EnvironmentId>): {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly refresh: () => void;
} {
  const environmentKey = useMemo(
    () => makeArchivedThreadsEnvironmentKey(environmentIds),
    [environmentIds],
  );
  const atom = archivedProjectsManager.getAtom(environmentKey);
  const result = useAtomValue(atom);
  const refresh = useCallback(() => {
    archivedProjectsManager.refresh(environmentIds);
  }, [environmentIds]);

  return {
    ...readArchivedThreadsSnapshotState(result),
    refresh,
  };
}
