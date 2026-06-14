/**
 * Contracts for the dev-server toggle feature.
 *
 * Three RPC methods let the client start a project's dev server, capture the
 * URL it prints, and stop it again. All three share the same payload and
 * success schemas.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";

// ---------------------------------------------------------------------------
// Stable method-id constants — WS_METHODS in rpc.ts maps to these strings.
// Defined here to avoid a circular import (devServer.ts → rpc.ts → devServer.ts).
// ---------------------------------------------------------------------------
export const DEV_SERVER_WS_METHODS = {
  devServerStart: "devServer.start",
  devServerStop: "devServer.stop",
  devServerStatus: "devServer.status",
} as const;

// ---------------------------------------------------------------------------
// Shared payload — all three methods accept the same input.
// ---------------------------------------------------------------------------

/**
 * Common input for devServer.start / devServer.stop / devServer.status.
 *
 * The server resolves the effective cwd as: worktreePath ?? projectCwd.
 */
export const DevServerPayload = Schema.Struct({
  /** The thread that owns this dev-server context. */
  threadId: ThreadId,
  /**
   * Worktree path (preferred). Nullable — supply null when not in a worktree.
   */
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * Project working directory (fallback when worktreePath is null).
   */
  projectCwd: Schema.NullOr(TrimmedNonEmptyString),
});
export type DevServerPayload = typeof DevServerPayload.Type;

// ---------------------------------------------------------------------------
// Success schema — shared by all three methods.
// ---------------------------------------------------------------------------

export const DevServerStatus = Schema.Struct({
  /** Whether the dev server process is currently running. */
  running: Schema.Boolean,
  /**
   * The URL the dev server printed to stdout (e.g. "http://localhost:5173").
   * Null when the server is not running or the URL has not yet been captured.
   */
  url: Schema.NullOr(Schema.String),
});
export type DevServerStatus = typeof DevServerStatus.Type;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class DevServerError extends Schema.TaggedErrorClass<DevServerError>()(
  "DevServerError",
  {
    message: Schema.String,
    reason: Schema.optional(Schema.String),
  },
) {}

// ---------------------------------------------------------------------------
// RPC definitions
// ---------------------------------------------------------------------------

export const WsDevServerStartRpc = Rpc.make(DEV_SERVER_WS_METHODS.devServerStart, {
  payload: DevServerPayload,
  success: DevServerStatus,
  error: Schema.Union([DevServerError, EnvironmentAuthorizationError]),
});

export const WsDevServerStopRpc = Rpc.make(DEV_SERVER_WS_METHODS.devServerStop, {
  payload: DevServerPayload,
  success: DevServerStatus,
  error: Schema.Union([DevServerError, EnvironmentAuthorizationError]),
});

export const WsDevServerStatusRpc = Rpc.make(DEV_SERVER_WS_METHODS.devServerStatus, {
  payload: DevServerPayload,
  success: DevServerStatus,
  error: Schema.Union([DevServerError, EnvironmentAuthorizationError]),
});
