interface ArchivableProject {
  readonly environmentId: string;
  readonly id: string;
  readonly archivedAt?: string | null | undefined;
}

export function isProjectArchived(project: {
  readonly archivedAt?: string | null | undefined;
}): boolean {
  return project.archivedAt != null;
}

/**
 * Drops archived projects and every thread under them, for lists that hide
 * the archive. Returns the inputs unchanged when nothing is archived, so
 * memoized consumers keep their identities.
 */
export function withoutArchivedProjects<
  P extends ArchivableProject,
  T extends { readonly environmentId: string; readonly projectId: string },
>(
  projects: ReadonlyArray<P>,
  threads: ReadonlyArray<T>,
): { readonly projects: ReadonlyArray<P>; readonly threads: ReadonlyArray<T> } {
  const archivedKeys = new Set<string>();
  for (const project of projects) {
    if (isProjectArchived(project)) archivedKeys.add(`${project.environmentId}:${project.id}`);
  }
  if (archivedKeys.size === 0) return { projects, threads };
  return {
    projects: projects.filter((project) => !isProjectArchived(project)),
    threads: threads.filter(
      (thread) => !archivedKeys.has(`${thread.environmentId}:${thread.projectId}`),
    ),
  };
}
