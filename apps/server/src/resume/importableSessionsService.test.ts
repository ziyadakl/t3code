import { ProjectId } from "@t3tools/contracts";
import { it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { buildImportedSessions, type ImportedSessionsDeps } from "./importableSessionsService.ts";
import type { ImportedBinding } from "./importableSessions.ts";

/**
 * `buildImportedSessions` chooses between the project-scoped binding query and
 * the unscoped fallback. The fallback (cwd → no project) is the safety-critical
 * branch: it exists so a path-representation mismatch can't silently drop rejoin
 * targets and resurrect the duplicate-on-rejoin bug. These tests pin both
 * branches directly with stub deps — no Claude SDK, no database.
 */

const binding = (threadId: string, resume: string, lastSeenAt: string): ImportedBinding => ({
  threadId,
  resumeCursor: { resume },
  lastSeenAt,
});

/** Base deps; each test overrides the fields it exercises. Records which list path ran. */
function makeDeps(
  overrides: Partial<ImportedSessionsDeps>,
  calls: { listBindings: boolean; listBindingsByProjectId: ProjectId | null },
): ImportedSessionsDeps {
  return {
    activeThreadIds: Effect.succeed(new Set<string>()),
    resolveProject: () => Effect.succeed(Option.none()),
    listBindings: () =>
      Effect.sync(() => {
        calls.listBindings = true;
        return [];
      }),
    listBindingsByProjectId: (projectId) =>
      Effect.sync(() => {
        calls.listBindingsByProjectId = projectId;
        return [];
      }),
    ...overrides,
  };
}

it.effect("falls back to the unscoped scan when the cwd resolves to no project", () =>
  Effect.gen(function* () {
    const calls = { listBindings: false, listBindingsByProjectId: null as ProjectId | null };
    const deps = makeDeps(
      {
        activeThreadIds: Effect.succeed(new Set<string>(["t-A"])),
        resolveProject: () => Effect.succeed(Option.none()),
        listBindings: () =>
          Effect.sync(() => {
            calls.listBindings = true;
            return [binding("t-A", "sess-A", "2026-01-01T00:00:00.000Z")];
          }),
      },
      calls,
    );

    const map = yield* buildImportedSessions(deps, "/some/unknown/cwd");

    // Rejoin target survived via the unscoped path.
    assert.equal(map.get("sess-A"), "t-A");
    assert.equal(calls.listBindings, true);
    // The scoped query must NOT run when there's no project.
    assert.equal(calls.listBindingsByProjectId, null);
  }),
);

it.effect("uses the project-scoped query when the cwd resolves to a project", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("proj-1");
    const calls = { listBindings: false, listBindingsByProjectId: null as ProjectId | null };
    const deps = makeDeps(
      {
        activeThreadIds: Effect.succeed(new Set<string>(["t-B"])),
        resolveProject: () => Effect.succeed(Option.some(projectId)),
        listBindingsByProjectId: (id) =>
          Effect.sync(() => {
            calls.listBindingsByProjectId = id;
            return [binding("t-B", "sess-B", "2026-01-01T00:00:00.000Z")];
          }),
        // If the scoped path were skipped and this ran, "sess-X" would leak in.
        listBindings: () =>
          Effect.sync(() => {
            calls.listBindings = true;
            return [binding("t-X", "sess-X", "2026-01-01T00:00:00.000Z")];
          }),
      },
      calls,
    );

    const map = yield* buildImportedSessions(deps, "/known/project/cwd");

    assert.equal(map.get("sess-B"), "t-B");
    assert.equal(map.has("sess-X"), false);
    assert.deepEqual(calls.listBindingsByProjectId, projectId);
    assert.equal(calls.listBindings, false);
  }),
);

it.effect("ignores bindings whose thread is not in the active snapshot", () =>
  Effect.gen(function* () {
    const calls = { listBindings: false, listBindingsByProjectId: null as ProjectId | null };
    const deps = makeDeps(
      {
        // "t-archived" is NOT in the active set, so its rejoin target is dropped.
        activeThreadIds: Effect.succeed(new Set<string>(["t-A"])),
        resolveProject: () => Effect.succeed(Option.none()),
        listBindings: () =>
          Effect.sync(() => {
            calls.listBindings = true;
            return [
              binding("t-A", "sess-A", "2026-01-01T00:00:00.000Z"),
              binding("t-archived", "sess-archived", "2026-01-02T00:00:00.000Z"),
            ];
          }),
      },
      calls,
    );

    const map = yield* buildImportedSessions(deps, "/some/cwd");

    assert.equal(map.get("sess-A"), "t-A");
    assert.equal(map.has("sess-archived"), false);
  }),
);
