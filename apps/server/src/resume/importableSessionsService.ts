/**
 * The "/resume" finder's I/O shell: a thin server service that lists a
 * project's importable Claude sessions via the SDK and delegates the rules to
 * the pure `selectImportableSessions`.
 *
 * Source: the Claude Agent SDK's documented `listSessions({ dir })` — the same
 * on-disk metadata Claude's own `/resume` picker uses (no transcript parsing).
 *
 * DEFERRED — origin/imported filtering: the pure rules can hide t3-origin
 * sessions and flag already-imported ones, but both need t3's
 * `provider_session_runtime` rows (the Claude session ids t3 created). Injecting
 * that persistence repo into the ws layer pulls `SqlClient` into the ws-layer
 * requirements, which the upstream `server.test.ts` ws-route tests do not
 * provide — so wiring it would force edits to that large upstream test file,
 * against the fork strategy. For this slice the service passes empty id sets
 * (lists every session, none flagged). Re-enabling the filter is the next task:
 * either provide an in-memory persistence layer to those tests, or derive the
 * t3-origin id set from a service already present in the ws-layer scope.
 * See CONTEXT.md ("Importable session") and docs/adr/0001.
 */
import { listSessions as sdkListSessions } from "@anthropic-ai/claude-agent-sdk";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  selectImportableSessions,
  type ImportableSession,
  type SessionInfo,
} from "./importableSessions.ts";

export class ImportableSessionsError extends Data.TaggedError("ImportableSessionsError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export interface ListImportableSessionsInput {
  /** The project's working directory; sessions are listed for this folder. */
  readonly projectCwd: string;
}

export interface ImportableSessionsServiceShape {
  readonly listForProject: (
    input: ListImportableSessionsInput,
  ) => Effect.Effect<ReadonlyArray<ImportableSession>, ImportableSessionsError>;
}

export class ImportableSessionsService extends Context.Service<
  ImportableSessionsService,
  ImportableSessionsServiceShape
>()("t3/resume/importableSessionsService") {}

/** Project the SDK's `SDKSessionInfo` onto the subset the finder consumes. */
function toSessionInfo(info: {
  readonly sessionId: string;
  readonly summary: string;
  readonly customTitle?: string;
  readonly lastModified: number;
}): SessionInfo {
  return {
    sessionId: info.sessionId,
    summary: info.summary,
    ...(info.customTitle !== undefined ? { customTitle: info.customTitle } : {}),
    lastModified: info.lastModified,
  };
}

const make = Effect.sync(() => {
  const listForProject: ImportableSessionsServiceShape["listForProject"] = ({ projectCwd }) =>
    Effect.gen(function* () {
      const sdkSessions = yield* Effect.tryPromise({
        try: () => sdkListSessions({ dir: projectCwd }),
        catch: (cause) =>
          new ImportableSessionsError({ detail: "Claude listSessions failed", cause }),
      });

      return selectImportableSessions(sdkSessions.map(toSessionInfo), {
        // Deferred (see file header): needs provider_session_runtime, which can't
        // reach the ws-layer test env without upstream-test churn.
        t3OriginSessionIds: new Set<string>(),
        importedSessionIds: new Set<string>(),
      });
    });

  return { listForProject } satisfies ImportableSessionsServiceShape;
});

export const ImportableSessionsServiceLive = Layer.effect(ImportableSessionsService, make);
