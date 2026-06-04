# CLI ↔ t3 conversation continuity (Claude first)

**Status:** accepted (2026-06-03) — design agreed, not yet implemented. Fork-local; see [FORK.md](../../FORK.md) and [CONTEXT.md](../../CONTEXT.md).

## Context & decision

We want the *same* agent conversation to be pick-up-able in both an agent's own standalone CLI (Claude Code first) and the t3 app, same agent on both sides. The priority direction is **terminal → t3** ("resume a CLI chat inside t3"); the reverse is nearly free and follows.

Verified that this is feasible with almost no new mechanism: t3 already drives Claude via the same `claude` binary against the shared `~/.claude` store, already records each thread's Claude session id as a resume cursor (`{resume, resumeSessionAt}`), and already runs threads in the project's repo root when no worktree is set. So a t3 Claude thread and a terminal Claude session land in the **same on-disk session pool** for that folder (confirmed with real data: a t3 thread's `.jsonl` sat in the same bucket as terminal sessions).

We therefore decided:

1. **Bridged conversations run in the project repo root, not an isolated worktree.** This puts both sides in the same Claude "project bucket" (Claude keys sessions by working directory) and makes the working files line up automatically, so resume "just works" both ways.
2. **Surface = a `/resume`-style affordance inside t3** that lists the project's past Claude sessions to pick from — matching what the user already reached for (they had typed `/resume` into t3's chat box and it did nothing).
3. **Generalize per-provider later.** t3's existing `listSessions` adapter method enumerates only *active* sessions, so a new "list resumable sessions" capability is added at the provider seam — Claude now, Codex/OpenCode later — rather than hard-coding a Claude-only disk reader into the orchestration layer.
4. **Imported chats show their prior messages** (readable text), and support **conversation-rewind** (continue from any earlier message, via the stable `resumeSessionAt` anchor).

## Considered options / rejected

- **Worktree isolation for bridged threads** — rejected: it splits the conversation into a different project bucket than the terminal and desyncs the files, defeating the whole point. Accepted trade-off: bridged threads edit the real working tree (no sandbox).
- **A new standalone t3 CLI** — rejected: the user means the agent's *own* CLI (Claude Code), not a new t3 terminal client.
- **Cross-agent resume** (Claude chat continued by a different agent) — out of scope; continuity is same-agent only.
- **File-rewind into imported history** — deferred, not impossible. The data exists (`~/.claude/file-history/<uuid>/` blobs + `file-history-snapshot` transcript entries), but using it means reading Claude's private, undocumented snapshot format and translating it to t3's git-checkpoint model — fragile against Claude updates, which the fork explicitly avoids. Revisit only if it proves essential.

## Consequences

- Fork exposure is mostly new files (a resumable-session service, a `/resume` UI) plus the known Bucket-2 seams: one new RPC method (`ws.ts` + `rpc.ts`). The provider-adapter interface edit is deferred until generalization.
- Bridged threads have no worktree isolation by design.
- Correct behavior depends on both sides using the same working-directory string; macOS's case-insensitive filesystem currently merges `Dev`/`dev` casing into one bucket, but exact-path alignment is the underlying requirement.
