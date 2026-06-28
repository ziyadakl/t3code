/**
 * QueueReadyCache — how many issues are queued for Sandcastle to pick up (open
 * GitHub issues carrying the pickup label).
 *
 * This is NOT in status.json, so it's queried from GitHub via the `gh` CLI. The
 * Sandcastle status RPC is polled every ~2s, so a naive `gh` call per poll would
 * be far too expensive. Instead `observe` is non-blocking: it returns the
 * last-known status immediately and forks a TTL-gated background refresh, so the
 * `gh` process spawns at most ~once per TTL per repo (deduped by an in-flight
 * flag, and keyed by repo so worktrees of the same repo share one query).
 *
 * On a query failure the prior count is kept (stale-while-revalidate) and an
 * `error` marker is set so the UI can show "unavailable" rather than a wrong
 * number. The cache never fails or blocks the poll.
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";

import type { QueueReadyError, QueueReadyStatus } from "@t3tools/contracts";

import {
  GitHubCli,
  layer as gitHubCliLayer,
  type GitHubCliError,
} from "../sourceControl/GitHubCli.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { RepositoryIdentityResolver } from "../project/Services/RepositoryIdentityResolver.ts";

/** Default Sandcastle pickup label (mirrors the loop's `--label` default). */
export const DEFAULT_QUEUE_READY_LABEL = "ready-for-agent";

/** How long a successful count is trusted before a background refresh. */
const DEFAULT_FRESH_TTL = Duration.seconds(45);
/** Shorter window after a failed query so it retries sooner. */
const DEFAULT_ERROR_TTL = Duration.seconds(15);

export interface QueueReadyCacheOptions {
  /** Trust window for a successful count (default 45s). Lowered in tests. */
  readonly freshTtl?: Duration.Input;
  /** Trust window after a failed query (default 15s). */
  readonly errorTtl?: Duration.Input;
}

interface CacheEntry {
  readonly status: QueueReadyStatus;
  /** A refresh fiber is running for this repo — don't fork another. */
  readonly inFlight: boolean;
}

interface RefreshDecision {
  readonly shouldRefresh: boolean;
  readonly status: QueueReadyStatus;
}

export interface QueueReadyCacheShape {
  /**
   * Non-blocking: return the last-known queue-ready status for the project's
   * GitHub repo (or null when the repo isn't GitHub / its identity is unknown),
   * and schedule a TTL-gated background refresh. Never spawns `gh` on this path.
   */
  readonly observe: (cwd: string, label: string) => Effect.Effect<QueueReadyStatus | null>;
}

export class QueueReadyCache extends Context.Service<QueueReadyCache, QueueReadyCacheShape>()(
  "t3/sandcastle/QueueReadyCache",
) {}

/** Map the typed `gh` failure category to the queue-ready wire marker. The
 *  category is set at the boundary (GitHubCliError.reason) so we never re-derive
 *  it from the human-readable detail string. */
function reasonToWireError(reason: GitHubCliError["reason"]): QueueReadyError {
  switch (reason) {
    case "missing":
      return "gh-missing";
    case "unauthed":
      return "gh-unauthed";
    default:
      return "query-failed";
  }
}

function isFresh(
  entry: CacheEntry | undefined,
  nowMs: number,
  freshTtlMs: number,
  errorTtlMs: number,
): boolean {
  if (!entry || entry.status.updatedAt === null) return false;
  const updatedMs = Date.parse(entry.status.updatedAt);
  if (Number.isNaN(updatedMs)) return false;
  const ttlMs = entry.status.error === null ? freshTtlMs : errorTtlMs;
  return nowMs - updatedMs < ttlMs;
}

export const makeQueueReadyCache = (options: QueueReadyCacheOptions = {}) =>
  Effect.gen(function* () {
    const gh = yield* GitHubCli;
    const resolver = yield* RepositoryIdentityResolver;
    const ref = yield* SynchronizedRef.make(new Map<string, CacheEntry>());
    const freshTtlMs = Duration.toMillis(options.freshTtl ?? DEFAULT_FRESH_TTL);
    const errorTtlMs = Duration.toMillis(options.errorTtl ?? DEFAULT_ERROR_TTL);

    /** Release this repo's in-flight slot if it's still claimed, leaving the
     *  last-known status untouched. Idempotent: a no-op once the normal
     *  success/failure path has already cleared the slot. */
    const releaseInFlight = (repoKey: string): Effect.Effect<void> =>
      SynchronizedRef.update(ref, (map) => {
        const entry = map.get(repoKey);
        if (!entry || !entry.inFlight) return map;
        return new Map(map).set(repoKey, { ...entry, inFlight: false });
      });

    const refresh = (cwd: string, label: string, repoKey: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const nowIso = DateTime.formatIso(yield* DateTime.now);
        const outcome = yield* gh.countOpenIssuesByLabel({ cwd, label }).pipe(
          Effect.map((count) => ({ ok: true as const, count })),
          Effect.catch((error) =>
            Effect.succeed({ ok: false as const, error: reasonToWireError(error.reason) }),
          ),
        );
        yield* SynchronizedRef.update(ref, (map) => {
          // Preserve the last good count on failure (stale-while-revalidate).
          const priorCount = map.get(repoKey)?.status.count ?? null;
          const status: QueueReadyStatus = outcome.ok
            ? { count: outcome.count, label, updatedAt: nowIso, error: null }
            : { count: priorCount, label, updatedAt: nowIso, error: outcome.error };
          return new Map(map).set(repoKey, { status, inFlight: false });
        });
      }).pipe(
        // A DEFECT (die) in the refresh would skip the update above and strand the
        // in-flight slot as `true` forever, permanently blocking future refreshes
        // for this repo. `ensuring` runs on every exit (success/failure/die/
        // interruption), so the slot is always released.
        Effect.ensuring(releaseInFlight(repoKey)),
      );

    const observe: QueueReadyCacheShape["observe"] = (cwd, label) =>
      Effect.gen(function* () {
        const identity = yield* resolver.resolve(cwd);
        if (!identity || identity.provider !== "github" || !identity.owner || !identity.name) {
          return null;
        }
        const repoKey = identity.canonicalKey;
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);

        const decision = yield* SynchronizedRef.modify(
          ref,
          (map): readonly [RefreshDecision, Map<string, CacheEntry>] => {
            const existing = map.get(repoKey);
            const status: QueueReadyStatus = existing?.status ?? {
              count: null,
              label,
              updatedAt: null,
              error: null,
            };
            if (isFresh(existing, nowMs, freshTtlMs, errorTtlMs) || (existing?.inFlight ?? false)) {
              return [{ shouldRefresh: false, status }, map];
            }
            // Claim the refresh slot (mark in-flight), keeping the prior status visible.
            const next = new Map(map).set(repoKey, { status, inFlight: true });
            return [{ shouldRefresh: true, status }, next];
          },
        );

        if (decision.shouldRefresh) {
          yield* Effect.forkDetach(refresh(cwd, label, repoKey));
        }
        return decision.status;
      });

    return { observe } satisfies QueueReadyCacheShape;
  });

export const QueueReadyCacheLive = Layer.effect(QueueReadyCache, makeQueueReadyCache()).pipe(
  // `gh` is not ambient at the runtime level (GitHubCli's layer is provided
  // privately inside SourceControlProviderRegistry), so self-provide it here.
  // RepositoryIdentityResolver is left to the runtime's existing Live.
  Layer.provide(gitHubCliLayer.pipe(Layer.provide(VcsProcess.layer))),
);
