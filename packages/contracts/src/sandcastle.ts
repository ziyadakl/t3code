/**
 * Contracts for the Sandcastle viewer feature.
 *
 * t3 NEVER imports Sandcastle code. This is a defensive Effect Schema mirror of
 * the shape Sandcastle writes to `<repoRoot>/.sandcastle/status.json`. Source of
 * truth for the shape: ~/Dev/Sandcastle/.sandcastle/lib/status/schema.ts (Zod).
 *
 * The single RPC, sandcastle.statusAll, reads many projects' status files on one
 * environment's server in a single round-trip and returns the reading server's
 * clock (serverNow) so staleness is computed against the same clock that wrote
 * the file (the loop and the reader live on the same machine).
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";

/** Bump in lockstep with Sandcastle's STATUS_SCHEMA_VERSION. Mismatch ⇒ "outdated". */
export const SANDCASTLE_STATUS_SCHEMA_VERSION = 1;

// Stable method-id constant (mirrors DEV_SERVER_WS_METHODS in devServer.ts).
export const SANDCASTLE_WS_METHODS = {
  sandcastleStatusAll: "sandcastle.statusAll",
} as const;

// --- snapshot shape (mirror of Sandcastle's Zod schema) --------------------

export const SandcastleIssuePhase = Schema.Literals([
  "planned",
  "implementer",
  "reviewer",
  "implementer-retry",
  "recovery",
  "merge",
  "merged",
  "needs-human",
  "deferred",
]);
export type SandcastleIssuePhase = typeof SandcastleIssuePhase.Type;

export const SandcastleRunState = Schema.Literals(["running", "done", "stopped", "restarting"]);
export type SandcastleRunState = typeof SandcastleRunState.Type;

export const SandcastleStatusHistoryEntry = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  branch: Schema.String,
  phase: SandcastleIssuePhase,
  completedAt: Schema.String,
});
export type SandcastleStatusHistoryEntry = typeof SandcastleStatusHistoryEntry.Type;

export const SandcastleStatusIssue = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  branch: Schema.String,
  phase: SandcastleIssuePhase,
  detail: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.String),
  attention: Schema.optional(Schema.Boolean),
});
export type SandcastleStatusIssue = typeof SandcastleStatusIssue.Type;

export const SandcastleStatusTotals = Schema.Struct({
  merged: Schema.Number,
  needsHuman: Schema.Number,
  requeued: Schema.Number,
  running: Schema.Number,
});
export type SandcastleStatusTotals = typeof SandcastleStatusTotals.Type;

export const SandcastleStatusRun = Schema.Struct({
  branch: Schema.String,
  repo: Schema.String,
  startedAt: Schema.String,
  iterations: Schema.Struct({
    current: Schema.Number,
    total: Schema.Number,
  }),
  maxConcurrent: Schema.Number,
});
export type SandcastleStatusRun = typeof SandcastleStatusRun.Type;

export const SandcastleStatusSnapshot = Schema.Struct({
  // Loose Number (not Literal) on purpose: we detect version mismatch in code so
  // a future Sandcastle schema bump flags "outdated" instead of failing decode.
  schemaVersion: Schema.Number,
  state: SandcastleRunState,
  run: SandcastleStatusRun,
  totals: SandcastleStatusTotals,
  issues: Schema.Array(SandcastleStatusIssue),
  updatedAt: Schema.String,
  activity: Schema.optional(Schema.String),
  // Append-only outcome log added in sandcastle-loop PR #14 (upstream). Absent
  // from the local Sandcastle checkout because that clone predates PR #14.
  history: Schema.optional(Schema.Array(SandcastleStatusHistoryEntry)),
});
export type SandcastleStatusSnapshot = typeof SandcastleStatusSnapshot.Type;

// --- queue-ready count (NOT from status.json) ------------------------------

/**
 * How many issues are queued for Sandcastle to pick up — open GitHub issues
 * carrying the pickup label. This is NOT in status.json; t3's server queries
 * GitHub for it (cached) and attaches it per entry. `error` lets the UI show
 * "unavailable" instead of a wrong number when the query can't run.
 */
export const QueueReadyStatus = Schema.Struct({
  /** Open issues carrying the label; null while the first query is pending or a
   *  query failed before any successful count. */
  count: Schema.NullOr(Schema.Number),
  /** The label counted (default "ready-for-agent"), echoed for display. */
  label: Schema.String,
  /** ISO time of the GitHub query behind `count`; null while pending. */
  updatedAt: Schema.NullOr(Schema.String),
  /** null | "gh-missing" | "gh-unauthed" | "query-failed". */
  error: Schema.NullOr(Schema.String),
});
export type QueueReadyStatus = typeof QueueReadyStatus.Type;

// --- per-project entry returned to the client ------------------------------

export const SandcastleStatusEntry = Schema.Struct({
  /** The project working directory this entry describes. */
  cwd: Schema.String,
  /** True when `<cwd>/.sandcastle/` exists (project is Sandcastle-enabled). */
  hasSandcastleDir: Schema.Boolean,
  /** Parsed snapshot, or null when no status.json / outdated / unparseable. */
  snapshot: Schema.NullOr(SandcastleStatusSnapshot),
  /** True when status.json's schemaVersion differs from what t3 understands. */
  schemaOutdated: Schema.Boolean,
  /** Human-readable read/parse failure, or null. */
  readError: Schema.NullOr(Schema.String),
  /** Queue-ready count from GitHub, or null when the repo isn't GitHub / its
   *  identity is unknown (feature N/A). Optional so older payloads predating
   *  this field still decode. */
  queueReady: Schema.optional(Schema.NullOr(QueueReadyStatus)),
});
export type SandcastleStatusEntry = typeof SandcastleStatusEntry.Type;

// --- RPC payload / result --------------------------------------------------

export const SandcastleStatusAllPayload = Schema.Struct({
  /** Project cwds to read on this environment's server. */
  cwds: Schema.Array(TrimmedNonEmptyString),
});
export type SandcastleStatusAllPayload = typeof SandcastleStatusAllPayload.Type;

export const SandcastleStatusAllResult = Schema.Struct({
  /** ISO time on the reading server — used for clock-skew-safe staleness. */
  serverNow: Schema.String,
  entries: Schema.Array(SandcastleStatusEntry),
});
export type SandcastleStatusAllResult = typeof SandcastleStatusAllResult.Type;

// --- RPC (unary — no `stream: true`) ---------------------------------------

export const WsSandcastleStatusAllRpc = Rpc.make(SANDCASTLE_WS_METHODS.sandcastleStatusAll, {
  payload: SandcastleStatusAllPayload,
  success: SandcastleStatusAllResult,
  error: EnvironmentAuthorizationError,
});
