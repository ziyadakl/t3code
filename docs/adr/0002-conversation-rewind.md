# Conversation rewind (non-destructive, unified with code-restore)

**Status:** design agreed (2026-06-11) — not yet implemented. Fork-local; see [FORK.md](../../FORK.md) and [CONTEXT.md](../../CONTEXT.md). Refines Cap 4 of [ADR-0001](./0001-cli-t3-conversation-continuity.md).

## Context

Users want Claude-CLI-style "rewind" (ESC-ESC → jump back to an earlier prompt and continue) inside t3, for **every** Claude-backed Thread — both terminal/CLI-imported chats and t3-native ones.

Exploration surfaced that t3 already ships a *different* rewind: the `thread.checkpoint.revert` command + the per-message undo button. That existing revert is **destructive and code-coupled** — it restores the working tree from a git checkpoint, rolls the provider session back, **and deletes** every message/turn after the target point from the projection (`CheckpointReactor.handleRevertRequested` → `thread.reverted` → `ProjectionPipeline` row deletion). That is not what we want as the primary rewind.

The Claude Agent SDK already supports the mechanism we need: `query` option `resumeSessionAt: <message-uuid>` ("resume only up to and including this message"). t3 **stores** an anchor (`resumeCursor.resumeSessionAt`) but **never passes it to the query** — `ClaudeAdapter.ts:2949-2950` builds query options with only `resume` + `sessionId`. Wiring that anchor through, *only for an intentional rewind*, is the core of this feature.

## Decisions (resolved via grill, 2026-06-11)

1. **Non-destructive conversation rewind.** Jump back to an earlier prompt and continue in the **same Thread / same Provider session**; the skipped-forward messages are **kept** (never deleted); the working tree is **not** touched. Mechanically: move `resumeSessionAt` back to an earlier message uuid and continue. (Matches CONTEXT.md "Rewind (resolved 2026-06-03)" and Claude Code native "Restore conversation".)
2. **Applies to all Threads** — native and imported alike (both run through `ClaudeAdapter`).
3. **One unified, Claude-CLI-style menu.** A single rewind entry point lets the user choose **"restore conversation only"** (non-destructive, default) or **"also restore my files"** (uses the existing git checkpoint). This requires **decoupling** the existing revert so file-restore no longer force-deletes the forward conversation.
4. **Abandoned forward messages disappear from the active view but are retained** (in the Claude transcript for imported chats, in t3's event log for native chats). No branch-browser in v1 — the chat stays a single readable line.
5. **Two entry points, one action.** ESC-ESC opens a rewind picker; the existing per-message undo button is **repointed** from the destructive revert to this unified menu. **Rewind targets are user prompts** (not mid-assistant messages).
6. **Pre-fill the rewound prompt for editing.** Landing back at a prompt drops its text into the composer to edit and re-send (the rewind anchors *just before* that prompt).
7. **Confirmations:** conversation-only rewind = **no** confirmation (safe, reversible, instant). "Also restore files" = **confirmation** (it overwrites the working tree).
8. **Mind-change affordance.** After a conversation-only rewind, an inline note ("your files are still at the newer state") carries an action button **"Restore files to this point too"** — runs the file-restore to the same anchor (with the file confirm). Shown **only when a git checkpoint exists** for that point (native chats; never for imported chats, which have none). File-restore is itself reversible (t3 snapshots files per turn → restore forward again), so there are **no dead ends** in either direction.

## Out of scope (v1)

- **File-rewind for imported chats** — deferred in ADR-0001 (needs Claude's private snapshot format). Imported chats only ever get conversation-only rewind.
- **Browsing abandoned branches** — they're retained but not surfaced as a tree.
- **"Redo forward"** after a rewind (rewind is backward-only in v1).
- **Editing an arbitrary mid-conversation message** — targets are prompts only.

## Design

### Data model — persist the provider message uuid (prerequisite)

Conversation-rewind anchors on a **Claude message uuid**, but t3 only stores its own `MessageId`; the Claude `uuid` lives **in memory** (`ClaudeAdapter.ts:2060` `context.lastAssistantUuid = message.uuid`) and is lost on restart. `projection_thread_messages` (Migration 005) has no provider-uuid column.

- **Migration:** add a nullable `provider_message_uuid TEXT` column to `projection_thread_messages` (+ index). Backward-safe/idempotent (follow the Migration 027 `PRAGMA table_info` pattern).
- **Write path:** thread the Claude `message.uuid` from the adapter through the message-created event into the projection, for both live turns and **imported transcript replay** (the replay already reads each `.jsonl` line, which carries `uuid`).
- The UI then maps "rewind to this prompt" → the provider uuid of the **assistant message immediately before that prompt** (so resuming "up to and including" it leaves the prompt itself re-askable).

### The rewind flow

New command **`thread.conversation.rewind`** (distinct from `thread.checkpoint.revert`), carrying the target t3 `messageId` (resolved server-side to the anchor uuid + turn count). Its reactor:

1. Sets the Thread's `resumeCursor.resumeSessionAt` to the anchor uuid (and stops auto-advancing it on this turn — today `updateResumeCursor`, `ClaudeAdapter.ts:1110-1128`, sets it to the latest assistant uuid on every continue; rewind must override that for the next start).
2. Marks the forward turns/messages **abandoned** in the projection (a flag, **not** a delete) so the active timeline hides them while the event log / transcript retain them. Emits an event the `ProjectionPipeline` applies as a hide, not a row-deletion.
3. Does **not** capture or restore any checkpoint; the working tree is untouched.

On the next turn, **`ClaudeAdapter` passes `resumeSessionAt` into the query options** (`ClaudeAdapter.ts:2949-2950`) — *only* when the cursor was set by an intentional rewind, not on ordinary continues. Claude then resumes from the anchor; the new (edited) prompt becomes the next turn in the same session.

### "Also restore files" + the decoupling

Split the existing bundled revert into two independent capabilities:

- **Conversation truncation** → replaced by the non-destructive rewind above (hide, don't delete).
- **File restore** → a standalone "restore working tree to turn N" that calls `CheckpointStore.restoreCheckpoint` **only** (no message deletion, no provider rollback of the *displayed* history beyond what the rewind already did).

The unified menu's **"also restore files"** = `thread.conversation.rewind` + file-restore to the same turn, in one confirmed action. The post-rewind **"Restore files to this point too"** button = the file-restore alone, applied to the earlier rewind anchor.

`CheckpointReactor.handleRevertRequested` (`apps/server/.../CheckpointReactor.ts:610-738`) and the `thread.reverted` projection deletion (`ProjectionPipeline.ts:743`) are refactored so the destructive path is no longer the only way to restore code. Keep edits to these upstream files minimal (FORK.md).

### UI (`apps/web`)

- **ESC-ESC** in `ChatView` opens a rewind picker listing the Thread's prior **user prompts**.
- The per-user-message undo button (`MessagesTimeline.tsx:97,410-413`) is **repointed** from `onRevertUserMessage`→destructive revert to the unified rewind menu.
- Menu: **Restore conversation only** (default, no confirm) · **Also restore files** (confirm; shown only when a checkpoint exists).
- On selecting a point: pre-fill that prompt's text into the composer; the abandoned forward messages drop out of the timeline.
- After a conversation-only rewind that left files ahead: a small inline note with the **"Restore files to this point too"** action (native + checkpoint present only).

### Imported vs native — source of truth

- **Imported chats:** the Claude transcript `.jsonl` is the source of truth; the projection is a display cache (already re-derived via the replay path, display-capped per the S1 work). "Retained" is automatic — the transcript is never written by a rewind.
- **Native chats:** t3's event log is the source of truth; "retained" means the abandoned turns' events stay; only the projection hides them.

Both share the single "mark abandoned, don't delete" projection mechanism.

## Edge cases

- **Archived/deleted Thread:** rewind only applies to active Threads (consistent with the resume picker, which already excludes archived/deleted — see `importableSessions.ts`).
- **Rewind, then rewind again / forward:** anchors are message uuids; a later rewind just moves the anchor again. No "redo forward" UI in v1, but file-restore can still move the tree forward (checkpoints per turn).
- **Imported chat, no checkpoints:** "also restore files" / the follow-up button are never offered (guarded on checkpoint existence).
- **Files-out-of-step after conversation-only rewind:** expected and surfaced via the inline note (decision 8); never blocked.

## Implementation outline (touchpoints)

- **Migration:** `0NN_ProjectionThreadMessageProviderUuid.ts` — add `provider_message_uuid` + index (Migration 027 pattern).
- **Adapter (`ClaudeAdapter.ts`, upstream — minimal):** pass `resumeSessionAt` into query options for intentional rewind (`:2949-2950`); ensure the message uuid reaches the projection; gate auto-advance of the cursor on rewind.
- **Contracts:** new `thread.conversation.rewind` command + a standalone file-restore command; extend the message type with the provider uuid; new RPC entries via the existing dispatch union (`rpc.ts`, `ws.ts:763`).
- **Orchestration:** decider case + reactor for the non-destructive rewind (mark-abandoned, set anchor); decouple `CheckpointReactor`/`ProjectionPipeline` so file-restore ≠ message-deletion.
- **Web (`ChatView.tsx`, `MessagesTimeline.tsx`):** ESC-ESC picker, repoint the per-message button to the unified menu, prompt pre-fill, the post-rewind inline note + "restore files too" action.

## Verification

- **Unit (`vitest`/`it.effect`):** rewind sets the anchor and hides (not deletes) forward turns; `resumeSessionAt` flows into query options only on intentional rewind; file-restore is independent of conversation truncation; the provider uuid is persisted on both live and replayed messages.
- **Migration test:** column added idempotently; existing rows get `NULL`.
- **End-to-end (dev runtime, `CI=1 mise exec -- bun dev`):** on a native chat — rewind a prompt, confirm files untouched + forward messages hidden + edited prompt continues the same session; then "restore files to this point" and confirm the tree moves and is reversible. On an imported/CLI chat — rewind works with no file options offered.
- **Live click-through** before declaring done (auto-deploy is currently OFF; deploy manually).
