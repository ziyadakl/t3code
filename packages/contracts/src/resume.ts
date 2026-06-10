/**
 * Contracts for the CLI ↔ t3 conversation-continuity feature ("/resume").
 * See repo CONTEXT.md and docs/adr/0001-cli-t3-conversation-continuity.md.
 */
import * as Schema from "effect/Schema";

/** Input: list the importable Claude sessions for a project directory. */
export const ResumeListImportableSessionsInput = Schema.Struct({
  /** The project's working directory (workspace root) whose sessions to list. */
  cwd: Schema.String,
});
export type ResumeListImportableSessionsInput = typeof ResumeListImportableSessionsInput.Type;

/** One past terminal Claude session the /resume picker can offer. */
export const ImportableSession = Schema.Struct({
  sessionId: Schema.String,
  title: Schema.String,
  /** Last-activity time, milliseconds since epoch. */
  lastActivityAt: Schema.Number,
  /** True when this session has already been imported into a Thread. */
  alreadyImported: Schema.Boolean,
  /**
   * When already imported, the id of the Thread this session lives in, so the
   * picker can REJOIN that Thread instead of creating a duplicate (CLI-parity:
   * one conversation, not copies). Absent for not-yet-imported sessions.
   */
  existingThreadId: Schema.optional(Schema.String),
});
export type ImportableSession = typeof ImportableSession.Type;

export const ResumeListImportableSessionsResult = Schema.Struct({
  sessions: Schema.Array(ImportableSession),
});
export type ResumeListImportableSessionsResult = typeof ResumeListImportableSessionsResult.Type;

/** Error raised by the /resume finder (listing past sessions). */
export class ResumeError extends Schema.TaggedErrorClass<ResumeError>()("ResumeError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    return `Resume finder error: ${this.detail}`;
  }
}
