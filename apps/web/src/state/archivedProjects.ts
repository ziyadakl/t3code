import { withoutArchivedProjects } from "@t3tools/client-runtime/state/archived-projects";

import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";

import { useProjects, useVisibleThreadShells } from "./entities";

/** Projects and visible threads without archived projects or the threads under them. */
export function useUnarchivedProjectsAndThreads(): {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
} {
  const projects = useProjects();
  const threads = useVisibleThreadShells();
  return withoutArchivedProjects(projects, threads);
}
