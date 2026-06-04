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

## Feasibility verification (2026-06-04)

A pre-build spike — static, against the installed SDK and the real on-disk session data, no live run — checked the two load-bearing unknowns. Both cleared, favorably:

- **Cap 4 (conversation-rewind) is feasible.** The Claude Agent SDK's query `Options` exposes `resumeSessionAt?: string` — *"when resuming, only resume messages up to and including the message with this UUID … resume from a specific point in the conversation"* (`sdk.d.ts:1703-1707`, SDK 0.3.154). That is exactly the anchor cap 4 needs. **The gap is on t3's side, not the SDK's:** t3 already *stores* `resumeSessionAt` in its resume cursor but never passes it into the query — `startSession` builds `queryOptions` with only `resume` + `sessionId` (`ClaudeAdapter.ts:2949-2950`). Wiring `resumeSessionAt` through — only for an *intentional* rewind, not every normal continue (every continue currently sets the cursor's `resumeSessionAt` to the latest assistant uuid) — is the cap-4 change. It edits `ClaudeAdapter.ts`, an upstream file (not in the FORK.md hot-list, but still Theo's) — keep the edit minimal.
- **Resume does not fork by default.** `forkSession` is opt-in (`sdk.d.ts:1426-1429`; CLI `--fork-session`). t3 assigns a fresh id only for brand-new sessions and resumes with `resume` alone — the two are mutually exclusive (`ClaudeAdapter.ts:2584-2586`) — so resuming a terminal session continues the **same** session id, non-destructively (matches native "Restore conversation"). Consequence for the "already in t3" flag: matching on the cursor's `resume` id is sound today, but to stay robust against any future fork behavior, also persist an explicit *imported-from* session id on the bridged Thread rather than relying only on the live cursor.
- **Project-membership filter:** the finder should decide which sessions belong to this project by reading the `cwd` field *inside* each `.jsonl` (present on every turn line), not by reconstructing Claude's directory-bucket hash — robust against whatever path encoding Claude uses.
- **Not yet run live.** End-to-end confirmation (t3 actually resuming a real terminal session, and rewinding to an earlier uuid) is deferred to the build of those slices, where it is verified empirically rather than from types alone.
