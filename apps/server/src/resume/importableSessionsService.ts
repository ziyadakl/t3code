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

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import {
  buildImportedSessionMap,
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

const make = Effect.gen(function* () {
  const directory = yield* ProviderSessionDirectory;
  const projection = yield* ProjectionSnapshotQuery;

  /**
   * Build the "already imported" map — Claude session id → the t3 Thread that
   * imported it — from the provider session bindings. Each thread created from
   * /resume carries a binding whose `resumeCursor.resume` is the original Claude
   * session id (seeded by ResumeSeedReactor, kept in step by the adapter). The
   * latest-active binding wins, so a rejoin lands on the most recent thread when
   * pre-fix duplicates already exist. Only threads still in the active snapshot
   * are eligible — archived/deleted threads fall through to a fresh import
   * rather than a broken rejoin. Best-effort: on any read failure the picker
   * still lists every session, just without rejoin targets.
   */
  const buildImportedSessions: Effect.Effect<ReadonlyMap<string, string>> = Effect.gen(
    function* () {
      const activeThreadIds = yield* projection.getShellSnapshot().pipe(
        Effect.map((snapshot) => new Set<string>(snapshot.threads.map((thread) => thread.id))),
        Effect.catch(() => Effect.succeed(new Set<string>())),
      );
      const bindings = yield* directory.listBindings();
      return buildImportedSessionMap(bindings, activeThreadIds);
    },
  ).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("resume picker: failed to build rejoin map", { cause }).pipe(
        Effect.as(new Map<string, string>() as ReadonlyMap<string, string>),
      ),
    ),
  );

  const listForProject: ImportableSessionsServiceShape["listForProject"] = ({ projectCwd }) =>
    Effect.gen(function* () {
      const sdkSessions = yield* Effect.tryPromise({
        try: () => sdkListSessions({ dir: projectCwd }),
        catch: (cause) =>
          new ImportableSessionsError({ detail: "Claude listSessions failed", cause }),
      });

      const importedSessions = yield* buildImportedSessions;

      return selectImportableSessions(sdkSessions.map(toSessionInfo), {
        // t3-origin hiding is still deferred (needs the t3-created id set); the
        // already-imported flag + rejoin target now come from the bindings.
        t3OriginSessionIds: new Set<string>(),
        importedSessions,
      });
    });

  return { listForProject } satisfies ImportableSessionsServiceShape;
});

export const ImportableSessionsServiceLive = Layer.effect(ImportableSessionsService, make);
