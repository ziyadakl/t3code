import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  SANDCASTLE_STATUS_SCHEMA_VERSION,
  SandcastleStatusSnapshot,
  type SandcastleStatusEntry,
} from "@t3tools/contracts";

// Effect 4 beta renamed `Either` → `Result`; the Schema decode-to-either helper
// is `decodeUnknownResult` (Success/Failure), success value lives on `.success`.
const decodeSnapshot = Schema.decodeUnknownResult(SandcastleStatusSnapshot);

export interface BuildStatusEntryInput {
  readonly cwd: string;
  readonly hasSandcastleDir: boolean;
  /** Raw contents of <cwd>/.sandcastle/status.json, or null if missing/unreadable. */
  readonly rawJson: string | null;
}

/**
 * Pure: turn raw filesystem facts into a SandcastleStatusEntry. Never throws.
 * Order: not-enabled → no-run → parse → version-peek → decode.
 */
export function buildStatusEntry(input: BuildStatusEntryInput): SandcastleStatusEntry {
  const base = {
    cwd: input.cwd,
    hasSandcastleDir: input.hasSandcastleDir,
    snapshot: null,
    schemaOutdated: false,
    readError: null,
  } satisfies SandcastleStatusEntry;

  if (!input.hasSandcastleDir) return base;
  if (input.rawJson === null) return base; // enabled, no run yet

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawJson);
  } catch (err) {
    return { ...base, readError: `Invalid JSON: ${(err as Error).message}` };
  }

  // Only a file NEWER than t3 understands is outdated. SANDCASTLE_STATUS_SCHEMA_VERSION
  // is the HIGHEST version we can read, so v1 and v2 both decode below; a v3+ file is
  // flagged so the viewer says "update t3" instead of silently mis-reading it.
  const version = (parsed as { schemaVersion?: unknown })?.schemaVersion;
  if (typeof version === "number" && version > SANDCASTLE_STATUS_SCHEMA_VERSION) {
    return { ...base, schemaOutdated: true };
  }

  const decoded = decodeSnapshot(parsed);
  if (Result.isFailure(decoded)) {
    return { ...base, readError: "status.json did not match the expected shape" };
  }
  return { ...base, snapshot: decoded.success };
}
