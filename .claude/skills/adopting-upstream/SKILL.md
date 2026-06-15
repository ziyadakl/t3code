---
name: adopting-upstream
description: Use when adopting a new upstream pingdotgg/t3code release into this fork — pulling upstream commits/tags into the `custom` branch via merge or rebase, reconciling them with the fork's own features, and shipping green to the VPS. Especially when the upstream change touches the build toolchain, dependencies, or migrations.
---

# Adopting Upstream Into the Fork

## Overview

The mechanical steps (fetch, advance `main` mirror, rebase `custom`, resolve the hot-file conflicts, land) live in **`FORK.md` — read it first; do NOT duplicate it here.** This skill is the *speed + safety* layer on top: the adoption is slow not because the checks are slow, but because of **wasted discovery and rework**. Kill those and it collapses from a multi-day slog to hours, with the checks just as strict.

**The final gate is non-negotiable.** "Faster" comes from tiering iteration and eliminating rework — never from weakening the end gate (full typecheck + full lint + full test + deploy smoke-test all stay).

## The four speed levers (this is the skill)

### 1. Root-cause first — never fix a wall of errors one-by-one
A toolchain/dep bump commonly produces **hundreds of type/test errors that are 1–3 root causes cascading**. Last adoption: ~340 type errors + ~115 crashing test files were **one missing `()`** on a `Schema.Defect` constructor. Before fixing anything or fanning out agents:
- Find the smallest set of broken **shared types / schemas / barrel exports** that everything downstream imports. Fix those.
- **Re-measure** the error count. Only then triage the remainder.
- Error counts BEFORE the root-cause fix are worthless for scoping — they over-estimate massively. Do not estimate effort or parallelize off them.
- If the count stays large *after* the root-cause fix + re-measure, it's genuinely many independent breakages — only *then* fan out by file-area (lever #3).

### 2. Front-load the known breakages (don't discover them at deploy time)
The moment the diff touches the **toolchain, deps, or migrations**, immediately fix the fork-owned files we KNOW break — in parallel, up front — instead of hitting them serially at the finish line. The checklist:

| Surface | Breaks how | Fix |
|---|---|---|
| `scripts/pack-server.ts` | reads catalog/overrides from the old location | resolve from `pnpm-workspace.yaml` via `scripts/lib/pnpm-workspace.ts` |
| `scripts/deploy-vps.sh` / `deploy-vps-tarball.sh` | build command form (`bun … run build` etc.) | match current `pnpm exec vp run --filter <pkg> build` |
| root `package.json` `lint` | monolithic linter OOMs | must route through `scripts/lint-all.ts` (per-dir) — never revert to one-pass |
| `FORK.md`, `scripts/install-git-hooks.sh` | stale `bun`/`mise`/`turbo` command refs | replace with the current `pnpm`/`vp` equivalents |
| node pin | `.mise.toml` may be gone | node is pinned via `engines`; don't reintroduce a removed pin |
| DB migrations | upstream + fork both add the same number | renumber the FORK's migrations to sit AFTER upstream's: rename the migration files, fix the registration array in `apps/server/src/persistence/Migrations.ts`, and fix any `*.test.ts` that seeds/asserts a migration number |

Grep the diff for these surfaces first thing on a toolchain/deps change.

### 3. Parallelize by tool and by file-area — not the same tool on shared caches
- Conflict resolution: split by **file-area / bucket** (FORK.md's hot-file map) across agents.
- Mechanical cleanup: split by **tool** — one agent owns typecheck fixes, one owns lint fixes. Do NOT run the same tool (esp. `tsc`/typecheck) concurrently on the shared `apps/server` build cache — it produces **phantom errors** (shared `.tsbuildinfo` race). Re-run clean before trusting any failure.
- `rerere` auto-replays past conflict fixes, but a **stale replay can mis-merge a hot file and still typecheck**. Diff-review every hot file `rerere` auto-resolves (esp. `orchestration.ts`) before trusting it.
- Always run a **single-threaded central verification barrier** yourself after each parallel wave; never relay a subagent's "green" without re-running.

### 4. Tiered verification — narrow while iterating, full gate once at the end
- While fixing: re-check **only the package you touched** (`pnpm exec vp run --filter <pkg> typecheck`, run just the changed test file). Fast loop.
- Once, at the end (the real gate): full reliable typecheck + full lint + full test + build + deploy smoke-test.

## Reliable command forms (the obvious ones lie)

| Need | Use | Why not the obvious one |
|---|---|---|
| Typecheck (full) | `pnpm -r --workspace-concurrency=1 --no-bail run typecheck` | recursive `vp run -r typecheck` **under-reports** (doesn't flush per-pkg output) |
| Lint (full) | `pnpm run lint` (the `scripts/lint-all.ts` wrapper) | monolithic `vp lint` **OOMs** the worker |
| Deploy (deps UNCHANGED vs main) | `pnpm run deploy` (file-swap) | — |
| Deploy (deps CHANGED vs main) | `pnpm run deploy:tarball` | file-swap **refuses** on dep changes (never `npm install`s on the VPS); a toolchain/dep adoption is always the tarball path |

`ssh hub` lands as **`deploy`** (not root); VPS runs **node v22** so the deploy's smoke-test (on the VPS) is the only thing that proves the new bundle boots there. **A deploy can exit non-zero (255 broken-pipe at the restart step) even on full success** — never treat the exit code as failure or re-deploy off it; verify independently: live HTTP 200 + a new process PID + clean startup logs (check via `ps`/`systemctl --user`, not root systemd — it's a `deploy`-user service). See `[[t3code-vps-deploy-runbook]]`.

## Order of operations (fast path)
1. Scope cheap in a throwaway worktree (FORK.md) — but **don't trust the error count until after lever #1**.
2. If toolchain/deps/migrations changed → run the **lever #2 checklist** in parallel immediately.
3. Rebase/merge per FORK.md; resolve conflicts by file-area (lever #3); `rerere` replays known fixes.
4. **Root-cause pass** (lever #1), re-measure, then parallel mechanical cleanup by tool.
5. Central barrier (lever #4 full gate). Land on `custom`.
6. Deploy via the right path (table above); verify HTTP + new PID + clean logs independently.

## Red flags — you're on the slow path
- About to fan out agents to fix 200 errors → STOP, find the root cause first.
- Discovering a broken deploy/pack/lint script *at deploy time* → it should have been in the lever #2 front-load.
- Running the full test suite after every small fix → tier it.
- Trusting a subagent's "green" → re-run the barrier yourself.
- Reverting `lint` to monolithic `vp lint`, or re-pinning a removed toolchain → you're undoing a deliberate fix.

## Reference
- `FORK.md` — canonical mechanical rebase/conflict procedure (three-bucket map, rerere). Read first.
- Memory: `[[t3code-v0027-toolchain-migration]]`, `[[t3code-vps-deploy-runbook]]`, `[[t3code-parallel-typecheck-phantom-errors]]`, `[[t3code-fork-strategy]]`.
