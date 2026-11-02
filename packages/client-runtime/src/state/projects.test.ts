import { describe, expect, it } from "vite-plus/test";

import { withoutArchivedProjects } from "./projects.ts";

const project = (environmentId: string, id: string, archivedAt: string | null = null) => ({
  environmentId,
  id,
  archivedAt,
});
const thread = (environmentId: string, projectId: string, id: string) => ({
  environmentId,
  projectId,
  id,
});

describe("withoutArchivedProjects", () => {
  it("hides an archived project and its threads in that environment only", () => {
    const projects = [
      project("local", "a", "2026-01-01T00:00:00.000Z"),
      project("local", "b"),
      project("remote", "a"),
    ];
    const threads = [
      thread("local", "a", "t1"),
      thread("local", "b", "t2"),
      thread("remote", "a", "t3"),
    ];

    const visible = withoutArchivedProjects(projects, threads);

    expect(visible.projects.map((entry) => `${entry.environmentId}:${entry.id}`)).toEqual([
      "local:b",
      "remote:a",
    ]);
    expect(visible.threads.map((entry) => entry.id)).toEqual(["t2", "t3"]);
  });

  it("returns the same arrays when nothing is archived", () => {
    const projects = [project("local", "a"), { environmentId: "local", id: "b" }];
    const threads = [thread("local", "a", "t1")];

    const visible = withoutArchivedProjects(projects, threads);

    expect(visible.projects).toBe(projects);
    expect(visible.threads).toBe(threads);
  });
});
