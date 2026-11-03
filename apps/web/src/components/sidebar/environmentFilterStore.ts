/**
 * The machine filter's own store and localStorage key, outside Upstream's uiStateStore.
 * Earlier builds kept the choice in `t3code:ui-state:v1`; the first load adopts it once and
 * copies it to the new key, because Upstream's next persist rewrites that object without it.
 */
import { EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";

export const ENVIRONMENT_FILTER_STORAGE_KEY = "t3code:sidebar-environment-filter:v1";
// Upstream's UI-state key, where earlier builds kept this choice.
const LEGACY_UI_STATE_STORAGE_KEY = "t3code:ui-state:v1";

// Blank ids would fail EnvironmentId's own validation, so they load as null.
function sanitizeEnvironmentId(value: unknown): EnvironmentId | null {
  return typeof value === "string" && value.trim().length > 0 ? EnvironmentId.make(value) : null;
}

function readJson(storage: Pick<Storage, "getItem">, key: string): unknown {
  try {
    const raw = storage.getItem(key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function readField(value: unknown, field: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[field]
    : undefined;
}

function persistEnvironmentFilter(
  storage: Pick<Storage, "setItem">,
  environmentId: EnvironmentId | null,
): void {
  try {
    storage.setItem(
      ENVIRONMENT_FILTER_STORAGE_KEY,
      JSON.stringify({ selectedEnvironmentId: environmentId }),
    );
  } catch {}
}

/** The saved choice: the own key if present, else the one-time read of the old field. */
export function readEnvironmentFilter(
  storage: Pick<Storage, "getItem" | "setItem">,
): EnvironmentId | null {
  const own = readJson(storage, ENVIRONMENT_FILTER_STORAGE_KEY);
  if (own !== undefined) {
    return sanitizeEnvironmentId(readField(own, "selectedEnvironmentId"));
  }
  const legacy = sanitizeEnvironmentId(
    readField(readJson(storage, LEGACY_UI_STATE_STORAGE_KEY), "sidebarEnvironmentFilterId"),
  );
  if (legacy !== null) persistEnvironmentFilter(storage, legacy);
  return legacy;
}

interface EnvironmentFilterStore {
  /** Machine (environment) the sidebar is filtered to, or null for all machines. Kept as
   * chosen even when that machine is gone; the sidebar derives the effective filter. */
  selectedEnvironmentId: EnvironmentId | null;
  setSelectedEnvironmentId: (environmentId: EnvironmentId | null) => void;
}

function readInitialEnvironmentFilter(): EnvironmentId | null {
  if (typeof window === "undefined") return null;
  try {
    return readEnvironmentFilter(window.localStorage);
  } catch {
    return null;
  }
}

export const useEnvironmentFilterStore = create<EnvironmentFilterStore>((set, get) => ({
  selectedEnvironmentId: readInitialEnvironmentFilter(),
  setSelectedEnvironmentId: (environmentId) => {
    if (get().selectedEnvironmentId === environmentId) return;
    set({ selectedEnvironmentId: environmentId });
    if (typeof window === "undefined") return;
    try {
      persistEnvironmentFilter(window.localStorage, environmentId);
    } catch {}
  },
}));
