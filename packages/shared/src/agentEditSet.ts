/**
 * The **Agent edit set** — the files the agent itself changed via its own
 * file-editing tools during one or more turns. Derived from a Thread's persisted
 * tool activities. See `docs/adr/0004-author-scoped-file-restore.md`.
 *
 * This is the single source of truth for "what the agent edited", used by BOTH
 * the per-turn "changed files" list (web) and the path-scoped file-restore
 * (server), so the list the user sees cannot disagree with what restore touches.
 *
 * SAFETY: paths are harvested ONLY from `file_change` tool activities. A file the
 * agent merely read (file_read / grep / a command) must never enter the set, or a
 * restore would revert a file the agent never changed.
 */

/** Record keys that may hold an edited file path. `file_path` (snake_case) is
 *  Claude's Edit/Write/MultiEdit key; the rest cover Codex and other shapes. */
const RECORD_PATH_KEYS = [
  "path",
  "file_path",
  "filePath",
  "relativePath",
  "filename",
  "newPath",
  "oldPath",
] as const;

/** Nested keys to recurse into when looking for paths. */
const NESTED_KEYS = [
  "item",
  "result",
  "input",
  "data",
  "changes",
  "files",
  "edits",
  "patch",
  "patches",
  "operations",
] as const;

const MAX_DEPTH = 4;
const MAX_FILES_PER_ACTIVITY = 12;

export interface ToolActivityLike {
  readonly kind: string;
  readonly payload?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pushPath(target: string[], seen: Set<string>, value: unknown): void {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) return;
  seen.add(normalized);
  target.push(normalized);
}

function collectPaths(value: unknown, target: string[], seen: Set<string>, depth: number): void {
  if (depth > MAX_DEPTH || target.length >= MAX_FILES_PER_ACTIVITY) return;

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPaths(entry, target, seen, depth + 1);
      if (target.length >= MAX_FILES_PER_ACTIVITY) return;
    }
    return;
  }

  const record = asRecord(value);
  if (!record) return;

  for (const key of RECORD_PATH_KEYS) {
    pushPath(target, seen, record[key]);
  }

  for (const nestedKey of NESTED_KEYS) {
    if (!(nestedKey in record)) continue;
    collectPaths(record[nestedKey], target, seen, depth + 1);
    if (target.length >= MAX_FILES_PER_ACTIVITY) return;
  }
}

/**
 * The file paths a single tool activity attributes to the agent. Harvests from
 * `payload.data`. Returns `[]` for anything that is not a file-change activity.
 */
export function editedPathsForActivity(activity: ToolActivityLike): string[] {
  const payload = asRecord(activity.payload);
  // SAFETY: only file_change activities attribute edits. A file_read / grep /
  // command that happens to carry a path must not enter the set.
  if (payload?.itemType !== "file_change") return [];
  const out: string[] = [];
  const seen = new Set<string>();
  collectPaths(asRecord(payload.data), out, seen, 0);
  return out;
}

/**
 * The Agent edit set across the given activities: the union of edited paths, in
 * first-seen order, de-duplicated.
 */
export function agentEditSet(activities: Iterable<ToolActivityLike>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const activity of activities) {
    for (const path of editedPathsForActivity(activity)) {
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}
