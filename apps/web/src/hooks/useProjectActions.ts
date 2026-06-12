import type { ScopedProjectRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { readEnvironmentApi } from "../environmentApi";
import { refreshArchivedProjectsForEnvironment } from "../lib/archivedProjectsState";
import { newCommandId } from "../lib/utils";

export function useProjectActions() {
  const archiveProject = useCallback(async (target: ScopedProjectRef) => {
    const api = readEnvironmentApi(target.environmentId);
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "project.archive",
      commandId: newCommandId(),
      projectId: target.projectId,
    });
    refreshArchivedProjectsForEnvironment(target.environmentId);
  }, []);

  const unarchiveProject = useCallback(async (target: ScopedProjectRef) => {
    const api = readEnvironmentApi(target.environmentId);
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "project.unarchive",
      commandId: newCommandId(),
      projectId: target.projectId,
    });
    refreshArchivedProjectsForEnvironment(target.environmentId);
  }, []);

  return {
    archiveProject,
    unarchiveProject,
  };
}
