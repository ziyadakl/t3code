# Author-scoped file-restore (agent edit set)

**Status:** design agreed (2026-06-16) — not yet implemented. Adds a fork-local module (`vcs/scopedCheckpointRestore.ts`) plus minimal edits to a small number of upstream VCS/checkpoint files per FORK.md's "edit only when necessary, keep small" allowance; see [FORK.md](../../FORK.md) and [CONTEXT.md](../../CONTEXT.md). Refines decisions 7–8 of [ADR-0002](./0002-conversation-rewind.md).

## Context

t3's per-turn **"changed files"** list and the **"restore files"** affordance both work off the author-blind **Checkpoint diff** (CONTEXT.md): a `git diff` between two whole-tree checkpoints (`CheckpointReactor.ts:259-275`), where each checkpoint is `git add -A -- .` over the entire working tree (`GitVcsDriver.ts:637-642`).

This causes two harms:

1. **Display (cosmetic).** The "changed files" list under a reply shows files the *user* hand-edited and build output, not only the agent's work — anything that changed in the folder between the two checkpoints.
2. **Restore (destructive — the real problem).** `RewindReactor.handleFilesRestoreRequested` and the legacy `thread.checkpoint.revert` both call `CheckpointStore.restoreCheckpoint`, which runs (`GitVcsDriver.ts:705-714`, **verified 2026-06-16**):

   ```
   git restore --source <commit> --worktree --staged -- .
   git clean -fd -- .
   git reset --quiet -- .
   ```

   This overwrites **every tracked file** to the checkpoint state and **`git clean -fd` deletes untracked files** — so a user's concurrent hand-edits are clobbered and files they created are deleted. This bites hardest on bridged/shared-working-tree Threads (CONTEXT.md: bridged Threads "edit the real working tree, giving up worktree isolation").

The agent's own edits are already observable without touching provider adapters: every provider's file-edit tool calls flow through a single funnel (`ProviderRuntimeIngestion.ts:577-620`) into persisted activities (`projection_thread_activities`, keyed by `turn_id`, carrying `payload_json`). The path lives in `payload.data` — at `data.input.file_path` for Claude (Edit/Write/MultiEdit) and `data.item.changes[].path` for Codex (apply_patch). So an **Agent edit set** is derivable per turn from data t3 already stores.

**Latent bug this fixes (verified 2026-06-16):** the existing web heuristic `collectChangedFiles` (`session-logic.ts:1088-1121`) harvests `path`/`filePath`/`newPath`/… but **not** Claude's snake_case `file_path`, and the only test is Codex-shaped — so the per-tool "changed files" display has been **silently empty for Claude** (the primary provider). The shared agent-edit-set harvester adds `file_path`, fixing this on the way.

**Prior art (Cursor, verified against cursor.com/docs 2026-06-16).** Cursor scopes restore to "all modified files" (the agent's change set), stored in an internal store "separate from Git", and rewinds code + chat together as one action. Its docs are **silent on protecting manual edits** and state outright: *"Only use them for undoing Agent changes; use Git for permanent version control."* There is a substantial 2025 trail of forum reports of restores that deleted files, emptied files, did nothing, or could not be undone. Cursor is the cautionary tale for exactly the harm above; this ADR chooses a deliberately safer posture.

## Decisions (resolved via grill, 2026-06-16)

1. **Scope both to the Agent edit set.** The per-turn "changed files" list and file-restore both use the **Agent edit set** (CONTEXT.md), not the author-blind **Checkpoint diff**. Restore-safety is the priority; the display fix falls out of the same attribution.
2. **Restore covers the whole undone span.** Restoring to point *P* undoes the agent's edits across **every turn after *P*** — the cumulative union of the agent edit sets of the undone turns — restoring each such file to its state at checkpoint *P*. Files only the user touched are left untouched.
3. **Create / modify / delete handling.** Agent-*created* files are deleted on restore-to-before; agent-*modified* files are reverted; the broad `git clean -fd -- .` is **removed** in favour of per-path handling.
4. **Fail safe on under-counting.** The Agent edit set is best-effort and may under-count (raw shell-command edits; Grok/OpenCode don't report paths today). Restore **only ever touches attributed files — never the whole tree.** When the Agent edit set for a span is **empty**, the "restore files" affordance is **hidden** (no whole-tree fallback); the user falls back to plain **git** for those cases — an intentional, narrow escape hatch, not a silent unsafe default.
5. **Both-edited exception.** A file the user *and* the agent both edited reverts **as a whole** on restore (no line-level attribution). Files *only* the user edited are always safe. This is the single accepted crack in "never touch my work".
6. **Conversation-rewind is unaffected.** It never touched files (ADR-0002 decision 1); only file-restore is scoped.
7. **Reversibility preserved (ADR-0002 decision 8).** Forward checkpoints still exist; restoring forward is likewise scoped to the spanned turns' Agent edit set; user files are untouched throughout — so there are still **no dead ends** and no loss.

## Out of scope (v1)

- **Line-level attribution** — a both-edited file reverts wholesale (decision 5).
- **Reliable path capture for Grok / OpenCode** — they fail safe to "no file-restore offered" (decision 4).
- **Scoping the explicit "full thread diff" raw view** (`CheckpointDiffQuery.getFullThreadDiff`) — it stays whole-tree; it is an explicit power-user git diff, not the per-turn summary.
- **Concurrent-edit detection** — attribution is via the agent's own tool calls, not by trying to detect which files the user touched.

## Design

### Agent edit set derivation (server, on-demand — no new storage)

At restore time, `RewindReactor.handleFilesRestoreRequested` already loads thread detail (`RewindReactor.ts:373-375`). Filter its activities to the undone span (`turnCount` > target) and to **`file_change` tool activities only** (`payload.itemType === "file_change"` — a file the agent merely *read* must never enter the set, or restore would revert a file the agent never changed), run the shared path-harvest over each `payload.data`, and union the paths → the Agent edit set for the span. Activities are persisted and queryable by turn (`projection_thread_activities`, Migration 005); ADR-0002 made rewind non-destructive (mark-abandoned, not delete), so the spanned turns' activities are retained. **No new table, no migration, no contract change** — the command already carries only `turnCount`.

### Shared attribution (single source of truth)

Extract `collectChangedFiles` / `extractChangedFiles` (today web-only, `session-logic.ts:1083-1141`) into a shared module (`@t3tools/shared`). The web display and the server restore then compute the **identical** Agent edit set from the same activity payloads — so what the user sees in the list cannot disagree with what restore actually touches.

### Path-scoped VCS (fork-local module + minimal upstream edits)

Extend `VcsCheckpointOps.restoreCheckpoint` and the `CheckpointStore` interface with an optional repo-relative `paths?: ReadonlyArray<string>`. Existing whole-tree callers pass nothing and are **unchanged**. (The diff is left whole-tree — the per-turn display filters client-side, see *Display* below, so no server-side scoped diff is needed in v1.) The path-scoped restore in `GitVcsDriver` partitions the paths via a `git cat-file -e <commit>:<path>` probe:

- `git restore --source <commit> --worktree --staged -- <paths…>` for paths present in the target tree (revert);
- for an agent path **absent** in the target tree (agent-created), a targeted `git rm -f --ignore-unmatch -- <path>` / unlink (delete) — **never** a broad `clean -fd`;
- `git reset --quiet -- <paths…>`.

The scoped-restore logic lives in the new fork-local `apps/server/src/vcs/scopedCheckpointRestore.ts` (a pure `planScopedRestore` planner + a thin `runScopedRestore` orchestrator). `GitVcsDriver.ts` (upstream) retains the unchanged legacy whole-tree restore path and adds a thin one-line delegation to `runScopedRestore` for the scoped case. `vcs/VcsDriver.ts` and `checkpointing/Services/CheckpointStore.ts` (upstream) carry only a minimal optional `paths?` field forwarded verbatim. These three upstream files are minimal, necessary edits per FORK.md's "edit only when necessary, keep small" allowance — they are not fork-local. The legacy whole-tree restore behavior is preserved and unchanged for all existing callers.

> **Note on present/created partition:** the `git cat-file -e <commit>:<path>` probe (partitioning paths into present-at-target vs. agent-created) is **required** and cannot be collapsed. `git restore --source` errors when asked to restore a path that does not exist at the target commit, so created paths must be separated out and handled via `git rm -f --ignore-unmatch` / unlink — there is no single-command "restore all then clean" equivalent that is both safe and scoped.

### Display (web, client-only)

The per-turn "changed files" expander (`MessagesTimeline.tsx:684`) renders `turnSummary.files` (Checkpoint diff) today. Change it to render that turn's **Agent edit set**, derived client-side from the turn's tool activities via the same shared harvester (the client already holds these as `WorkLogEntry.changedFiles`). **No server or contract change** for display.

### Affordance gating

`computeRevertTurnCountByUserMessageId` (`session-logic.ts:1266-1306`) offers file-restore today when `summary.files.length > 0` (Checkpoint diff non-empty). Re-gate it on the **Agent edit set for the span** being non-empty (decision 4).

## Edge cases

- **Empty Agent edit set, non-empty Checkpoint diff** (user-only changes, or shell-only / lossy-provider agent changes) → file-restore not offered; conversation-rewind still available; user uses git.
- **Agent created then deleted a file within the span** → net-absent; restore is a no-op for it.
- **Path now gitignored / outside repo** → scoped by git pathspec; harmless.
- **Imported chats (no checkpoints)** → file-restore already never offered (ADR-0002); unaffected.

## Implementation outline (touchpoints)

- **Shared:** new `@t3tools/shared` agent-edit-set module (move `collectChangedFiles` / `extractChangedFiles`; keep a web re-export to minimise churn).
- **Server VCS — DONE (slice 2):** new fork-local `apps/server/src/vcs/scopedCheckpointRestore.ts` holds the scoped-restore logic (`planScopedRestore` + `runScopedRestore`). Upstream `VcsDriver.ts` + `checkpointing/Services/CheckpointStore.ts` receive a minimal optional `paths?` field (forwarded verbatim). Upstream `GitVcsDriver.ts` keeps the unchanged whole-tree path and adds a thin delegation to `runScopedRestore` for the scoped case. Real-git integration tests in `CheckpointStore.test.ts`.
- **Server orchestration (fork-local):** `RewindReactor.handleFilesRestoreRequested` — derive the span's Agent edit set, pass `paths` into `restoreCheckpoint`; guard/no-op when empty.
- **Web:** `MessagesTimeline.tsx` (render Agent edit set), `session-logic.ts` (re-gate `computeRevertTurnCountByUserMessageId`; use the shared harvester).
- **No migration. No change to `packages/contracts/src/orchestration.ts`.**

## Verification

- **Unit (`vitest` / `it.effect`):** Agent-edit-set derivation per-turn and cumulative-span; path-scoped restore reverts only listed paths, deletes agent-created files, leaves untracked user files in place; empty set → no-op + affordance hidden; both-edited file reverts wholesale; shared-harvester parity between web display and server restore.
- **Integration (dev runtime, `CI=1 mise exec -- bun dev`):** native chat — agent edits files A, B; user hand-edits C *and* creates D during the turn; restore → A, B reverted, **C and D untouched**, no untracked deletion. A Grok/OpenCode turn → file-restore not offered.
- **Live click-through** before declaring done (auto-deploy is OFF; deploy manually).
