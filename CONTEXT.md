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

## Relationships

- A **Thread** is backed by exactly one **Provider session** at a time, via a **Resume cursor**.
- A **Provider session** physically lives in one **Project bucket**, keyed by the **working directory** it ran in.
- Resuming a **Provider session** only works from *its own* **Project bucket** — i.e. the same working directory. Different directory ⇒ "No conversation found." (verified 2026-06-03)
- A **Thread** runs in its **Worktree** if it has one, otherwise the project's repo root.

## Flagged ambiguities

- **"the CLI"** — initially ambiguous. Resolved: the *agent's own* standalone CLI (Claude Code first), **not** a new t3 CLI, and **not** running one agent's chat inside a different agent. Same agent, two places.
- **Target experience (resolved 2026-06-03):** a t3 **Thread** should appear in Claude's native `/resume` picker like any normal Claude Code session — no copy-paste command, no special button. This works **iff** the Thread ran in the project's repo root (so its Provider session lands in the repo's **Project bucket**, which is what `/resume` lists for that folder).
- **Priority direction (resolved 2026-06-03):** the more important half is **terminal → t3** ("resume a CLI chat *inside* t3"), built first. The reverse (t3 → terminal) is nearly free and comes second.
- **VERIFIED with real data (2026-06-03):** t3 already stores Claude **Provider sessions** in the *shared* `~/.claude` store and runs Claude **Threads** in the repo root (no Worktree by default — real threads had `worktree_path: null`, branch `custom`/`main`). A real t3 thread's session file (`c55dc749…`, 26 msgs) physically sits in the **same Project bucket** as terminal sessions. macOS's case-insensitive filesystem merges the `Dev` vs `dev` path-casing difference into one bucket, so the two share a single session pool. t3 state lives at `~/.t3/userdata/state.sqlite`; resume pointer is `provider_session_runtime.resume_cursor_json` = `{resume, resumeSessionAt}`.
- **Display of an imported chat (resolved 2026-06-03):** **show** the earlier messages (readable text), so the user can see the chat and pick a point — not "show nothing". Full byte-perfect reproduction of every tool call/sidechain is *not* required for v1.
- **Rewind (resolved 2026-06-03):** two kinds. **Conversation-rewind** (jump to an earlier message and continue a new path) is in v1 — it uses the stable `resumeSessionAt` anchor. **File-rewind** (restore the working tree to an earlier point of the *imported* chat) is **deferred**: the data exists (`~/.claude/file-history/<uuid>/` blobs + `file-history-snapshot` transcript entries with `trackedFileBackups`), so it's *possible*, but it means reading Claude's private, undocumented snapshot format and translating it to t3's git-checkpoint model — fragile against Claude updates, against the fork's "don't depend on churny internals" principle. Revisit only if it proves essential.
- **"conversation"** — maps to both a t3 **Thread** and a **Provider session**; they are linked, not the same thing.
- **"resume / pick up the context"** — means continue the *same* conversation on the other side. **Resolved (2026-06-03):** carry the *chat*; run **both sides in the same folder** (the real repo, no private Worktree for bridged Threads) so the files line up on their own. Trade-off accepted: bridged Threads edit the real working tree, giving up worktree isolation.
