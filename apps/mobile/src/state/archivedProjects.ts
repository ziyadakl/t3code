import { withoutArchivedProjects } from "@t3tools/client-runtime/state/archived-projects";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { useMemo } from "react";

import { useNavigationThreadShells, useProjects } from "./entities";

/** Projects and the given threads, without archived projects or their threads. */
export function useUnarchivedProjectsWithThreads(threads: ReadonlyArray<EnvironmentThreadShell>): {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
} {
  const projects = useProjects();
  return useMemo(() => withoutArchivedProjects(projects, threads), [projects, threads]);
}

/** Navigation lists without archived projects or their threads. */
export function useUnarchivedNavigationProjectsAndThreads() {
  return useUnarchivedProjectsWithThreads(useNavigationThreadShells());
}
