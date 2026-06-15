# FORK.md — how this fork works

> This is a **fork** of [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) (Theo's "T3 Code").
> The whole point of the setup below is to **keep pulling Theo's updates cleanly** while our own
> work stays separate and doesn't fight his.
>
> This file is the shared understanding. If you (or a new Claude session) are picking this up,
> **read this first.** It is the source of truth; do not relearn it from scratch.
>
> _Last updated: 2026-06-03. Status: fork is bootstrapped, nothing custom built yet._

---

## The plain-English version

- **Theo's repo moves fast.** His own `AGENTS.md` says it's a "VERY EARLY WIP," so he ships big,
  frequent changes. Our job is to ride along without constant merge pain.
- **Two branches, kept apart:**
  - `main` is a **clean mirror** of Theo's repo. We never put our own work here.
  - `custom` is **where all our work lives.**
- **The golden rule: add new files, don't edit his.** When our changes live in new files (or whole
  new sub-projects), Theo's updates and ours touch different files and never collide. Editing his
  existing files is what causes painful conflicts — so we only do it when a feature truly has no
  other way, and then we keep the edit as small as possible.
- **Conflict auto-memory is on.** Git is set to remember how we resolve any conflict and replay
  that fix automatically next time the same one shows up (`rerere`). So a conflict, once solved,
  generally stays solved.
- **Pull his updates often, in small steps.** Small, frequent catch-ups are far easier than one
  giant one months later.

## How easy a given feature is to keep separate — the three buckets

This is the heart of what we worked out. How clean things stay depends on *what kind* of feature it is:

1. **New screens / views / a whole new tool — nearly conflict-free.**
   The web app discovers screens just from which files exist in a folder, and the project picks up
   brand-new sub-projects automatically. New files only, nothing of Theo's touched.

2. **Features where the server has to do something new — manageable.**
   These have to register themselves in a few central "switchboard" files (see the reference below).
   Adding a background service is basically a one-line addition. Adding a new browser↔server command
   is a real edit, not a clean plug-in, so expect small conflicts there — `rerere` softens the repeats.

3. **Changing how the core agent conversation itself works — genuinely conflict-prone.**
   The full list of agent events/commands lives in one big central file the whole app keys off of.
   It can't be sidestepped, and it's exactly the kind of file Theo reshapes often. Avoid extending
   the core protocol if you can; if a feature truly needs it, treat that file as a known battleground.

**Cleanest option of all:** when a feature allows it, build it as its **own separate project that
talks to t3code**, rather than living inside his code. Then there is nothing of ours in his files.

We deliberately did **not** pre-build "plug your stuff in here" scaffolding — empty hooks would just
be guesses about his structure that rot as he changes things. We apply the small "seam" edit *when* a
feature actually needs a central file, not before.

---

## Reference (for precise, repeatable steps)

### Remotes & branches
- `origin` → `ziyadakl/t3code` (our fork — safe to push to)
- `upstream` → `pingdotgg/t3code` (push URL is blocked on purpose, so we can't accidentally PR to Theo)
- `main` — clean mirror of `upstream/main`; **never commit here**
- `custom` — all our work; branch off `custom` for individual features

### Pulling Theo's updates
```sh
git fetch upstream
git checkout main
git merge --ff-only upstream/main     # main stays a pure mirror
git push origin main
git checkout custom
git rebase main                       # rerere auto-replays past conflict fixes
```
Do this frequently. Resolve any conflict once; `rerere` remembers it.

### Local git config already set (lives in `.git/config`, not committed)
- `rerere.enabled = true`
- `rerere.autoupdate = true`

### The conflict-prone "hot files" (verified 2026-06-03)
Touch these only when a feature genuinely requires it; keep edits minimal.

| File | What it is | Bucket | Conflict risk |
|---|---|---|---|
| `packages/contracts/src/orchestration.ts` | Core agent event/command unions (`OrchestrationCommand`, `OrchestrationEvent`); ~1,300 lines | 3 | **High** — central, heavily reshaped upstream |
| `apps/server/src/ws.ts` | Browser↔server command registry (`WsRpcGroup.of({…})`) + auth-scope map | 2 | Medium — real edits, handlers close over lots of local scope |
| `packages/contracts/src/rpc.ts` | Method-name constants (`WS_METHODS`) every command starts from | 2 | Medium |
| `apps/server/src/server.ts` | Effect service graph (`.pipe(Layer.provideMerge(…))` chain) | 2 | **Low** — new service = one line appended after `AuthLayerLive` |

### The low-conflict seams (prefer these)
- **New web screen:** add a file under `apps/web/src/routes/`. `routeTree.gen.ts` is autogenerated —
  don't hand-edit it. No edit to Theo's files.
- **New package/sub-project:** create a folder under `apps/` or `packages/`. Root `package.json`
  uses globs (`apps/*`, `packages/*`), so it's picked up with no edit.
- **New server service:** append one `Layer.provideMerge(YourLayerLive)` at the end of the chain in
  `server.ts`; keep `YourLayerLive` in your own new file.

### Required checks before declaring work done (from Theo's `AGENTS.md`)
- `pnpm run fmt`, `pnpm run lint`, `pnpm run typecheck` must all pass
- Use `pnpm run test` (the vite-plus test runner — `@effect/vitest`'s `it.effect` rides on it)
- If touching native mobile code, `pnpm run lint:mobile` must also pass

### Toolchain notes
- Node is pinned via `engines` (`^24.13.1`); the package manager is `pnpm@10.24.0`.
- Run commands directly with `pnpm …` (e.g. `pnpm install`, `pnpm run test`).
  There is no `.mise.toml` / `bun` / `turbo` — those are gone.
- There is **no plugin / settings / config layer** — additions must be real code changes.
