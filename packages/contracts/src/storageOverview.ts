import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId } from "./baseSchemas.ts";

export const StorageOverviewCategoryKey = Schema.Literals([
  "worktrees",
  "runtime",
  "database",
  "logs",
  "other",
]);
export type StorageOverviewCategoryKey = typeof StorageOverviewCategoryKey.Type;

export const StorageOverviewCategory = Schema.Struct({
  key: StorageOverviewCategoryKey,
  bytes: NonNegativeInt,
});
export type StorageOverviewCategory = typeof StorageOverviewCategory.Type;

export const StorageOverviewThread = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  archived: Schema.Boolean,
});
export type StorageOverviewThread = typeof StorageOverviewThread.Type;

export const StorageOverviewWorktree = Schema.Struct({
  path: Schema.String,
  projectRoot: Schema.NullOr(Schema.String),
  projectName: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  /** Null when measuring timed out or hit the entry cap. */
  bytes: Schema.NullOr(NonNegativeInt),
  uncommittedFiles: NonNegativeInt,
  threads: Schema.Array(StorageOverviewThread),
});
export type StorageOverviewWorktree = typeof StorageOverviewWorktree.Type;

export const StorageOverview = Schema.Struct({
  measuredAt: IsoDateTime,
  totalBytes: NonNegativeInt,
  categories: Schema.Array(StorageOverviewCategory),
  worktrees: Schema.Array(StorageOverviewWorktree),
});
export type StorageOverview = typeof StorageOverview.Type;

export const StorageGetOverviewInput = Schema.Struct({
  refresh: Schema.optionalKey(Schema.Boolean),
});
export type StorageGetOverviewInput = typeof StorageGetOverviewInput.Type;

export const StorageRemoveWorktreeInput = Schema.Struct({
  path: Schema.String,
  /** Files the user was told would be lost; the server refuses if more are uncommitted now. */
  allowUncommittedFiles: NonNegativeInt,
  /** Commit every change on the worktree's own branch (local only) before removing it. */
  saveChanges: Schema.optionalKey(Schema.Boolean),
});
export type StorageRemoveWorktreeInput = typeof StorageRemoveWorktreeInput.Type;

export const StorageRemoveWorktreeResult = Schema.Struct({
  bytesFreed: Schema.NullOr(NonNegativeInt),
  /** Short sha of the commit that saved the changes; null when nothing was saved. */
  savedCommit: Schema.NullOr(Schema.String),
});
export type StorageRemoveWorktreeResult = typeof StorageRemoveWorktreeResult.Type;

export class StorageOverviewError extends Schema.TaggedError<StorageOverviewError>()(
  "StorageOverviewError",
  {
    message: Schema.String,
  },
) {}
