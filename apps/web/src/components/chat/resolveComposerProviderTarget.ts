import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import type { ProviderInstanceEntry } from "../../providerInstances";

/**
 * The provider instance + driver kind a composer draft is currently
 * targeting. Both fields are derived from the SAME entry so the model
 * picker icon/tab (keyed on `instanceId`) and everything keyed on
 * `driverKind` (capabilities, banner, dispatch metadata) can never disagree.
 */
export interface ComposerProviderTarget {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
}

export interface ResolveComposerProviderTargetInput {
  /**
   * Instance entries, default-first per kind (i.e. the output of
   * `sortProviderInstanceEntries(deriveProviderInstanceEntries(providers))`).
   */
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  /**
   * Candidate instance ids in priority order. Conventionally:
   *   1. the composer draft's `activeProvider` (the user's unsaved pick)
   *   2. the active thread's session `providerInstanceId`
   *   3. the active thread's persisted model-selection `instanceId`
   *   4. the project default's `instanceId`
   * Nullish entries are skipped.
   */
  readonly candidates: ReadonlyArray<ProviderInstanceId | null | undefined>;
  /** Driver kind the thread is locked to (server threads), else null. */
  readonly lockedProvider: ProviderDriverKind | null;
  /** Continuation group the thread is locked to, else null. */
  readonly lockedContinuationGroupKey: string | null;
}

function matchesLock(
  entry: ProviderInstanceEntry,
  lockedProvider: ProviderDriverKind | null,
  lockedContinuationGroupKey: string | null,
): boolean {
  if (lockedProvider && entry.driverKind !== lockedProvider) return false;
  if (lockedContinuationGroupKey && entry.continuationGroupKey !== lockedContinuationGroupKey) {
    return false;
  }
  return true;
}

/** Enabled and probed healthy — usable without raising a provider-status banner. */
function isReady(entry: ProviderInstanceEntry): boolean {
  return entry.enabled && entry.status === "ready";
}

/**
 * Run one resolution pass against a usability predicate, in candidate priority
 * order, then by-kind, then any-match. Returns null when nothing satisfies the
 * predicate so the caller can try a looser one.
 */
function pick(
  input: ResolveComposerProviderTargetInput,
  explicit: ProviderInstanceId | null,
  requestedKind: ProviderDriverKind | null,
  predicate: (entry: ProviderInstanceEntry) => boolean,
): ComposerProviderTarget | null {
  const { entries, candidates, lockedProvider, lockedContinuationGroupKey } = input;

  // Candidate priority (the draft pick / thread / project default).
  for (const candidate of candidates) {
    if (!candidate) continue;
    const match = entries.find((entry) => entry.instanceId === candidate && predicate(entry));
    if (match && matchesLock(match, lockedProvider, lockedContinuationGroupKey)) {
      return { instanceId: match.instanceId, driverKind: match.driverKind };
    }
  }

  // First matching instance of the requested driver kind.
  if (requestedKind) {
    const byKind = entries.find(
      (entry) =>
        predicate(entry) &&
        entry.driverKind === requestedKind &&
        (!lockedContinuationGroupKey ||
          entry.continuationGroupKey === lockedContinuationGroupKey),
    );
    if (byKind) {
      return { instanceId: byKind.instanceId, driverKind: byKind.driverKind };
    }
  }

  // Any matching instance overall — but never leave a locked kind.
  if (!lockedProvider) {
    const any = entries.find(
      (entry) =>
        predicate(entry) &&
        (!lockedContinuationGroupKey || entry.continuationGroupKey === lockedContinuationGroupKey),
    );
    if (any) {
      return { instanceId: any.instanceId, driverKind: any.driverKind };
    }
  }

  return null;
}

/**
 * Resolve which configured instance the composer is targeting, returning the
 * instance id AND its driver kind as a matched pair.
 *
 * Resolution prefers, in order:
 *   1. A READY instance (enabled + probed healthy) — candidate first, then by
 *      the requested driver kind, then any ready instance.
 *   2. Failing that, any ENABLED instance (same candidate → kind → any order),
 *      so an enabled-but-broken provider is still surfaced when nothing works.
 *   3. Last resort when nothing is enabled: the first candidate's own entry,
 *      else the first entry, else the default instance for the locked/Codex
 *      kind — so the composer always has a concrete identity to show.
 *
 * Two properties matter:
 *
 *  - A DISABLED candidate (e.g. a `codex` project default while only Claude is
 *    enabled) never wins over an enabled instance — keeping the picker identity
 *    in lockstep with the model that resolves via `resolveSelectableProvider`.
 *
 *  - An ENABLED-BUT-NOT-READY candidate (e.g. a `codex` project default on a
 *    remote server where the Codex CLI isn't installed) never wins over a ready
 *    provider. Without this, a fresh draft you're composing on Claude still
 *    inherited the broken Codex default and raised its "not installed" banner.
 *    The broken provider is only chosen when there is no ready alternative, so a
 *    genuinely all-broken setup still warns; the provider's real status remains
 *    visible in Settings either way.
 *
 * `ChatView` resolves the draft-status banner through this same helper, so the
 * picker icon/tab and the banner always agree on one provider.
 */
export function resolveComposerProviderTarget(
  input: ResolveComposerProviderTargetInput,
): ComposerProviderTarget {
  const { entries, candidates, lockedProvider } = input;
  const explicit = candidates.find((candidate) => !!candidate) ?? null;
  const requestedKind =
    lockedProvider ?? entries.find((entry) => entry.instanceId === explicit)?.driverKind ?? null;

  // Prefer a ready provider; fall back to any enabled one (so a broken-but-
  // enabled provider is still surfaced when nothing is ready).
  return (
    pick(input, explicit, requestedKind, isReady) ??
    pick(input, explicit, requestedKind, (entry) => entry.enabled) ??
    lastResort(input, explicit)
  );
}

/** Nothing is enabled — keep a concrete identity to show. */
function lastResort(
  input: ResolveComposerProviderTargetInput,
  explicit: ProviderInstanceId | null,
): ComposerProviderTarget {
  const { entries, lockedProvider } = input;
  const withinLock = (entry: ProviderInstanceEntry): boolean =>
    !lockedProvider || entry.driverKind === lockedProvider;
  const explicitEntry = entries.find((entry) => entry.instanceId === explicit);
  if (explicitEntry && withinLock(explicitEntry)) {
    return { instanceId: explicitEntry.instanceId, driverKind: explicitEntry.driverKind };
  }
  const first = entries.find(withinLock);
  if (first) {
    return { instanceId: first.instanceId, driverKind: first.driverKind };
  }
  const fallbackKind = lockedProvider ?? ProviderDriverKind.make("codex");
  return { instanceId: defaultInstanceIdForDriver(fallbackKind), driverKind: fallbackKind };
}
