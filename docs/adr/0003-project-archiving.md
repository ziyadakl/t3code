# Project archiving (reversible hide, distinct from deletion)

**Status:** accepted (2026-06-11) — implemented on `custom`, pending live verification. Fork-local; see [FORK.md](../../FORK.md) and [CONTEXT.md](../../CONTEXT.md).

## Context

A user wanted to remove projects they're not working on from the sidebar **without losing the chats** — "if you can archive a project that's fine, I just need to not see it; and adding it back shows the chats that were in there."

The only existing action was **"Remove project"**, a permanent soft-delete (`project.delete`) that cascade-clears every Thread in the Project. Worse, it failed confusingly: the sidebar feed hides archived Threads, so a Project whose Threads were all archived *looked* empty, but the server's delete invariant counts archived (not-deleted) Threads as still active and rejected a non-force delete:

> `Orchestration command invariant failed (project.delete): Project '…' is not empty and cannot be deleted without force=true.`

So the user had no reversible "hide" and hit a raw error when reaching for delete. **Threads already support archiving** (`thread.archive`/`thread.unarchive`, `archivedAt`, a settings "Archived threads" panel). The fix is to extend that proven pattern to the **Project** aggregate, and to make the permanent-delete path robust against the archived-Thread case.

## Decisions

1. **Archiving a Project is a reversible hide, distinct from deletion.** A nullable `archivedAt` on the Project (mirroring Threads). Archived ≠ deleted: archived data is retained and restorable; deleted (`deletedAt`) is permanent. **Keep both actions** in the UI — "Archive project" (the easy, safe one) and a relabeled **"Delete permanently"**.
2. **No cascade to Threads.** Archiving a Project sets only the Project-level `archivedAt`; it does **not** change any Thread's own archive state. Unarchiving restores the Project; Threads return in whatever state they were. (Consequence: a Thread the user had *individually* archived stays in "Archived threads" after the Project is restored. The intended workflow is "archive the **Project**, not individual Threads.")
3. **Feed-exclusion at the SQL layer**, not in-store render-filtering. Archived Projects are excluded from the active client snapshot (`archived_at IS NULL`), exactly as archived Threads are. **Why:** the project list has ~13 consumers, ~8 user-facing pickers (sidebar, command-palette project search + new-thread targets, environment switcher, default-project selection…). Keeping archived Projects in the store would require an archived-filter at every one, and any miss is a visible leak. Feed-exclusion makes leaks structurally impossible. A separate `getArchivedProjectsSnapshot` query feeds the settings panel.
4. **An archived Project's active Threads must not orphan.** Because we don't cascade, `listActiveThreadRows` also excludes Threads whose Project is archived (an `EXISTS` guard on `projection_projects.archived_at IS NULL`), or they'd appear in the feed with no Project node to render under.
5. **Two restore paths.** (a) A settings **"Archived projects"** panel (Unarchive + Delete-permanently, the latter being the only place to permanently delete an archived Project since it isn't in the sidebar). (b) **Restore-on-re-add**: re-adding an archived Project's folder offers to restore it rather than create a duplicate — this is what "adding it back shows the chats" meant.
6. **"Delete permanently" retries with force.** A Project whose Threads are all archived looks empty to the client → it sends a non-force delete → the server rejects (archived count as active). The sidebar catches that specific invariant and offers a confirmed force-retry, so permanent delete actually works.

## Out of scope (v1)

- **Cascade archiving** (Project archive → archive its Threads, tracking which were auto-archived for exact restore). Considered; rejected for simplicity and to avoid mutating Thread state the user set deliberately. Revisit only if "restore shows everything" proves essential.
- **Landing on the restored Project's existing latest thread** after restore-on-re-add. The Project re-enters the store asynchronously (shell stream), so navigation currently lands on a new thread; the chats are one click away in the sidebar. Tracked follow-up — needs a project→latest-thread lookup or a store-subscription wait.
- **Browsing/bulk operations** on archived Projects beyond the per-row Unarchive / Delete.

## Design (touchpoints — mirrors the thread-archive pattern)

- **Contracts:** `archivedAt` on `OrchestrationProject`/`OrchestrationProjectShell` (with `withDecodingDefault(null)` for backward-safe decoding of pre-feature rows); `project.archive`/`project.unarchive` commands; `project.archived`/`project.unarchived` events + payloads; two new read RPCs (`getArchivedProjectsSnapshot`, `getArchivedProjectByWorkspaceRoot`). Additive-only edits to the hot files `orchestration.ts`/`rpc.ts` (FORK.md).
- **Server:** decider cases + `requireProjectNotArchived`/`requireProjectArchived` invariants (and a `thread.create` not-archived guard); projector + `ProjectionPipeline` write `projection_projects.archived_at`; migrations `033`/`034` (ADD COLUMN + index, idempotent PRAGMA-guarded); `ProjectionSnapshotQuery` feed-exclusion + archived-projects snapshot + by-workspaceRoot lookup; `ws.ts` maps `project.archived`→`project-removed` / `project.unarchived`→`project-upserted` so the existing client reducers handle them with no new store code. Bootstrap restores (unarchives) an archived Project for a re-added cwd instead of creating a duplicate.
- **Web:** `useProjectActions` (archive/unarchive); Sidebar "Archive project" menu item + "Delete permanently" relabel + force-retry on the not-empty invariant; `ArchivedProjectsPanel` settings panel; `CommandPalette` restore-on-re-add prompt.

### Known coupling (accepted)

The force-retry classifier (`Sidebar.logic.ts isProjectNotEmptyForceError`) matches on the invariant **message string**, because the structured `OrchestrationCommandInvariantError` is flattened to a plain `message` at the RPC boundary. This is a latent coupling to the upstream error copy. Mitigation: a unit test pins the classifier; a server-side test should guard the exact invariant string so an upstream copy change is caught. A machine-readable error code across the RPC boundary is the proper long-term fix (deferred — touches the contracts hot file).

### Considered and not done: deduplicating the new server queries

`getArchivedProjectsSnapshot` mirrors `getArchivedShellSnapshot`, and `getArchivedProjectByWorkspaceRoot` mirrors the row-mapping in `getActiveProjectByWorkspaceRoot` — both in the **upstream** `ProjectionSnapshotQuery.ts`. Extracting shared helpers (`assembleShellSnapshot`, `mapOrchestrationProjectRow`) would be cleaner in isolation but refactors Theo's existing methods, raising future merge-conflict risk. Per FORK.md ("keep edits to upstream files minimal"), the fork-safe mirrored duplication is preferred here. Revisit if these methods ever move into fork-owned files.

## Verification

- **Unit (`vitest`/`it.effect`):** decider archive/unarchive emit the right events; invariants reject double-archive / unarchive-of-active and `thread.create` under an archived Project; the classifier matches the rendered invariant message.
- **Real-SQL:** an archived Project + its Thread both leave the active shell feed (the Thread does not orphan) and appear in the archived snapshot; active-vs-archived workspace-root lookups split correctly. Bootstrap restores an archived Project for the same cwd instead of duplicating.
- **Suite:** server 1108 passing, web 1002 passing (8 pre-existing fails), typecheck clean.
- **Live click-through (the real gate):** archive a Project → it leaves the sidebar with its chats; settings → Archived projects → Unarchive → it returns with chats; re-add the folder while archived → restore prompt → no duplicate; "Delete permanently" on a Project whose chats are all archived → force-retry confirm → it deletes. (Auto-deploy is currently OFF — `git config t3.autoDeploy false`; deploy manually.)
