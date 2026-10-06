import { isProjectArchived } from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { ArchiveX } from "lucide-react";
import { useMemo } from "react";

import { useEnvironments } from "../../state/environments";
import { useProjects, useThreadShells } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Archived projects in the given environments, each with a way back to the sidebar. */
export function ArchivedProjectsSection({
  environmentIds,
}: {
  environmentIds: ReadonlyArray<EnvironmentId>;
}) {
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });

  const archivedProjects = useMemo(() => {
    const scoped = new Set(environmentIds);
    return projects
      .filter((project) => isProjectArchived(project) && scoped.has(project.environmentId))
      .toSorted((left, right) => (right.archivedAt ?? "").localeCompare(left.archivedAt ?? ""));
  }, [environmentIds, projects]);

  const threadCountByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of threads) {
      const key = `${thread.environmentId}:${thread.projectId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [threads]);

  if (archivedProjects.length === 0) return null;
  const showEnvironment = environmentIds.length > 1;
  const environmentLabel = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)?.label ?? null;

  return (
    <SettingsSection title="Archived projects">
      {archivedProjects.map((project) => {
        const threadCount = threadCountByProject.get(`${project.environmentId}:${project.id}`) ?? 0;
        const label = showEnvironment ? environmentLabel(project.environmentId) : null;
        return (
          <SettingsRow
            key={`${project.environmentId}:${project.id}`}
            title={
              <span className="inline-flex items-center gap-2">
                <ProjectFavicon project={project} />
                {project.title}
              </span>
            }
            description={
              <>
                Archived {formatRelativeTimeLabel(project.archivedAt ?? project.updatedAt)}
                {` · ${threadCount} thread${threadCount === 1 ? "" : "s"}`}
                {label ? ` · ${label}` : null}
                {` · ${project.workspaceRoot}`}
              </>
            }
            control={
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="shrink-0"
                aria-label={`Unarchive project ${project.title}`}
                onClick={() => {
                  void (async () => {
                    const result = await updateProject({
                      environmentId: project.environmentId,
                      input: { projectId: project.id, archived: false },
                    });
                    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                      const error = squashAtomCommandFailure(result);
                      toastManager.add(
                        stackedThreadToast({
                          type: "error",
                          title: "Failed to unarchive project",
                          description:
                            error instanceof Error ? error.message : "An error occurred.",
                        }),
                      );
                    }
                  })();
                }}
              >
                <ArchiveX className="size-3.5" />
                <span>Unarchive</span>
              </Button>
            }
          />
        );
      })}
    </SettingsSection>
  );
}
