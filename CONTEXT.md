# CONTEXT — Conversations & resume

The shared language for how a back-and-forth agent conversation is stored, identified, and
resumed across t3code and an agent's own standalone CLI. Seeded 2026-06-03 while designing
CLI ↔ t3 conversation continuity (Claude first). This is a fork — see [FORK.md](./FORK.md).

## Language

**Thread**:
t3code's term for one back-and-forth agent conversation (id = UUID, stored in t3's own SQLite at `~/.t3code/userdata/state.sqlite`).
_Avoid_: conversation, session, chat — at the t3 domain level it is always a Thread.

**Provider session**:
The underlying agent's own conversation instance that actually holds the model context (for Claude, a Claude session id). A Thread is backed by a Provider session.
_Avoid_: calling this a "thread" — that collides with t3's Thread.

**Resume cursor**:
The pointer t3 stores per Thread so it can reconnect to that Thread's Provider session. For Claude it is `{ resume: <sessionId>, resumeSessionAt: <lastAssistantUuid> }` — the exact data `claude --resume` needs.

**Provider / agent backend**:
The engine that runs a Thread: Claude, Codex, Cursor, or OpenCode. The first target is Claude.

**Project bucket**:
Claude's on-disk grouping of sessions by working directory: `~/.claude/projects/<cwd-hash>/<sessionId>.jsonl`. Both t3 and the standalone CLI share `~/.claude` by default (no `homePath` override).

**Worktree**:
An isolated git working copy t3 may create for a Thread. When present, the Thread runs there instead of the repo root — which puts its Provider session in a *different* Project bucket than a terminal session run from the repo.

**Checkpoint**:
A per-turn snapshot of a Thread's whole working tree, stored as a git shadow-commit ref (`refs/t3/checkpoints/…`) — not a branch commit, so it never touches the user's git history. A pre-turn baseline and a post-turn checkpoint bracket each turn; file-restore/rewind target a checkpoint.

**Checkpoint diff**:
Every file that differs between two **Checkpoints**. **Author-blind**: because each checkpoint is the whole working tree, the diff includes files the *user* hand-edited and build output, not only the agent's work. Backs the raw git diff view — but is **not** the source of the per-turn "changed files" list or of file-restore (those use the **Agent edit set**).

**Agent edit set** (added 2026-06-16):
The files the agent *itself* changed during a turn, via its own file-editing tools (Claude `Edit`/`Write`/`MultiEdit`, Codex `apply_patch`, etc.), derived from the agent's tool-call activities. This is t3's attribution of "what the agent did", and it is what a turn's "changed files" list shows and what a **file-restore** reverts. Best-effort: it may **under-count** — a file the agent changes by running a shell command, or a provider that doesn't report paths (Grok/OpenCode today), won't appear. By design t3 **fails safe** on under-counting: restore touches only the attributed files, never the whole tree, so the user's own separate work is never clobbered (the one exception is a file the user *and* the agent both edited — it reverts as a whole).
_Avoid_: equating the whole-tree **Checkpoint diff** with "the agent's changes" — the diff is author-blind.

**Importable session**:
A past Claude Provider session in this project's Project bucket that t3's `/resume` picker offers to pull into a new Thread. Defined as: a top-level chat (not a background sub-agent / sidechain session), with real content (not an empty or abandoned stub), that originated in the **terminal** (not one t3 itself created), in this project's working directory. A terminal session already pulled into a Thread is still listed but flagged "already in t3".
_Avoid_: listing t3-originated or sub-agent sessions in the picker by default.

**Session origin**:
Where a Provider session was started: the **terminal** (the user's own Claude CLI) or **t3** (the app drove Claude itself). The picker shows terminal-origin sessions; t3-origin ones are already Threads and are hidden by default. The two are distinguishable on disk.

**Project**:
The t3 aggregate that groups Threads by a workspace root (a folder). Holds a `workspaceRoot`, model defaults, and scripts. Identified by a UUID; deletion is soft (`deletedAt`). (The Threads inside a Project are the **conversations** this context is otherwise about.)

**Archived thread / Archived project** (added 2026-06-11 → see [ADR-0003](docs/adr/0003-project-archiving.md)):
**Archiving** is a *reversible hide* — set a nullable `archivedAt` timestamp; the row is filtered out of the active sidebar feed but **never deleted**. It exists for both aggregates: a **Thread** can be archived (pre-existing) and now a **Project** can be archived. Archiving a Project hides the Project node and all its Threads from the sidebar without touching any Thread's own archive state (**no cascade**); unarchiving restores it with its conversations intact.
_Avoid_: conflating **archive** (reversible, data retained) with **delete** (`deletedAt`, permanent — clears the conversation history). They are distinct lifecycle states.

**Empty project** (for deletion):
A Project the server's `project.delete` invariant treats as deletable without `force`. The invariant counts a Thread as still occupying the Project while its `deletedAt IS NULL` — so **archived (but not deleted) Threads still make a Project non-empty**. A Project whose Threads are all archived therefore *looks* empty in the sidebar (archived Threads are feed-hidden) yet is **not** empty for deletion; "Delete permanently" detects that rejection and retries with `force`.

## Relationships

- A **Thread** is backed by exactly one **Provider session** at a time, via a **Resume cursor**.
- A **Provider session** physically lives in one **Project bucket**, keyed by the **working directory** it ran in.
- Resuming a **Provider session** only works from *its own* **Project bucket** — i.e. the same working directory. Different directory ⇒ "No conversation found." (verified 2026-06-03)
- A **Thread** runs in its **Worktree** if it has one, otherwise the project's repo root.
- A **Thread** belongs to one **Project**. Both share the same lifecycle states: **active** (`archivedAt` null, `deletedAt` null) → shown; **archived** (`archivedAt` set) → reversibly hidden; **deleted** (`deletedAt` set) → permanent. Archiving a **Project** hides it and its Threads from the active feed without changing any Thread's own state (no cascade); re-adding an archived Project's folder offers to **restore** (unarchive) it rather than create a duplicate.

## Flagged ambiguities

- **"the CLI"** — initially ambiguous. Resolved: the *agent's own* standalone CLI (Claude Code first), **not** a new t3 CLI, and **not** running one agent's chat inside a different agent. Same agent, two places.
- **Target experience (resolved 2026-06-03):** a t3 **Thread** should appear in Claude's native `/resume` picker like any normal Claude Code session — no copy-paste command, no special button. This works **iff** the Thread ran in the project's repo root (so its Provider session lands in the repo's **Project bucket**, which is what `/resume` lists for that folder).
- **Priority direction (resolved 2026-06-03):** the more important half is **terminal → t3** ("resume a CLI chat *inside* t3"), built first. The reverse (t3 → terminal) is nearly free and comes second.
- **VERIFIED with real data (2026-06-03):** t3 already stores Claude **Provider sessions** in the *shared* `~/.claude` store and runs Claude **Threads** in the repo root (no Worktree by default — real threads had `worktree_path: null`, branch `custom`/`main`). A real t3 thread's session file (`c55dc749…`, 26 msgs) physically sits in the **same Project bucket** as terminal sessions. macOS's case-insensitive filesystem merges the `Dev` vs `dev` path-casing difference into one bucket, so the two share a single session pool. t3 state lives at `~/.t3/userdata/state.sqlite`; resume pointer is `provider_session_runtime.resume_cursor_json` = `{resume, resumeSessionAt}`.
- **Display of an imported chat (resolved 2026-06-03):** **show** the earlier messages (readable text), so the user can see the chat and pick a point — not "show nothing". Full byte-perfect reproduction of every tool call/sidechain is *not* required for v1.
- **Rewind (resolved 2026-06-03):** two kinds, mirroring Claude Code's *native* rewind, which deliberately separates them (native menu offers "Restore conversation" vs "Restore code" as distinct actions — verified against Claude Code rewind docs 2026-06-03). **Conversation-rewind** (jump to an earlier message and continue) is in v1 — it uses the stable `resumeSessionAt` anchor. It mirrors native "Restore conversation": it stays in the **same Thread / Provider session** (not a new branch Thread), it is **non-destructive** (the skipped-past messages are retained in the on-disk transcript tree, as native keeps them), and it **leaves the working tree untouched**. Mechanically it just moves `resumeSessionAt` back to an earlier message uuid and continues the same session. **File-rewind** (native "Restore code" — restore the working tree to an earlier point of the *imported* chat) is **deferred**: the data exists (`~/.claude/file-history/<uuid>/` blobs + `file-history-snapshot` transcript entries with `trackedFileBackups`), so it's *possible*, but it means reading Claude's private, undocumented snapshot format and translating it to t3's git-checkpoint model — fragile against Claude updates, against the fork's "don't depend on churny internals" principle. Because native treats the two as separate actions, doing conversation-rewind without file-rewind is **faithful to native**, not a compromise. Revisit file-rewind only if it proves essential. **Refined 2026-06-11 → see [ADR-0002](docs/adr/0002-conversation-rewind.md):** v1 applies to **all** Threads (native + imported), behind **one Claude-CLI-style menu** ("restore conversation only" vs "also restore files"); abandoned forward messages are hidden-but-retained; the rewound prompt is pre-filled for editing; the existing destructive `thread.checkpoint.revert` is **decoupled** so code-restore no longer force-deletes the conversation; and a post-rewind "restore files to this point too" affordance covers a change of mind (git-checkpoint chats only).
- **Picker contents (resolved 2026-06-04):** the `/resume` picker lists **Importable sessions** only — terminal-origin chats for this project. t3-origin chats are hidden by default (they are already Threads; a future toggle can reveal them); background sub-agent / sidechain sessions and empty stubs are always hidden; an already-imported terminal chat is shown but flagged "already in t3". Distinguishing these on disk was verified against the real bucket on 2026-06-04 (origin marker, sidechain flag, content size, and a stored title for display all present).
- **Surface (resolved 2026-06-04):** two entry points, one picker — a `/resume` command in the t3 chat box (caught by t3 before it reaches Claude) and a button near "new thread" in the sidebar.
- **"conversation"** — maps to both a t3 **Thread** and a **Provider session**; they are linked, not the same thing.
- **"resume / pick up the context"** — means continue the *same* conversation on the other side. **Resolved (2026-06-03):** carry the *chat*; run **both sides in the same folder** (the real repo, no private Worktree for bridged Threads) so the files line up on their own. Trade-off accepted: bridged Threads edit the real working tree, giving up worktree isolation.
