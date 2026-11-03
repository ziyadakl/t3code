import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ENVIRONMENT_FILTER_STORAGE_KEY,
  readEnvironmentFilter,
  useEnvironmentFilterStore,
} from "./environmentFilterStore";

const remoteEnvironmentId = EnvironmentId.make("environment-remote");

function createStorageStub() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("sidebar machine filter store", () => {
  let storage: ReturnType<typeof createStorageStub>;

  beforeEach(() => {
    storage = createStorageStub();
    vi.stubGlobal("window", { localStorage: storage });
    useEnvironmentFilterStore.setState({ selectedEnvironmentId: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores the sidebar machine filter and resets it to all machines", () => {
    const { setSelectedEnvironmentId } = useEnvironmentFilterStore.getState();

    setSelectedEnvironmentId(remoteEnvironmentId);
    expect(useEnvironmentFilterStore.getState().selectedEnvironmentId).toBe("environment-remote");

    setSelectedEnvironmentId(null);
    expect(useEnvironmentFilterStore.getState().selectedEnvironmentId).toBeNull();
  });

  it("restores the sidebar machine filter across reloads", () => {
    useEnvironmentFilterStore.getState().setSelectedEnvironmentId(remoteEnvironmentId);

    expect(JSON.parse(storage.getItem(ENVIRONMENT_FILTER_STORAGE_KEY) ?? "{}")).toEqual({
      selectedEnvironmentId: "environment-remote",
    });
    expect(readEnvironmentFilter(storage)).toBe("environment-remote");
  });

  it("restores an all-machines choice made after a machine was picked", () => {
    useEnvironmentFilterStore.getState().setSelectedEnvironmentId(remoteEnvironmentId);
    useEnvironmentFilterStore.getState().setSelectedEnvironmentId(null);

    expect(readEnvironmentFilter(storage)).toBeNull();
  });

  it.each([42, "", "   ", { id: "environment-remote" }, undefined])(
    "treats a persisted machine filter of %j as all machines",
    (value) => {
      storage.setItem(
        ENVIRONMENT_FILTER_STORAGE_KEY,
        JSON.stringify({ selectedEnvironmentId: value }),
      );

      expect(readEnvironmentFilter(storage)).toBeNull();
    },
  );

  it("treats an unreadable saved value as all machines", () => {
    storage.setItem(ENVIRONMENT_FILTER_STORAGE_KEY, "{not json");

    expect(readEnvironmentFilter(storage)).toBeNull();
  });

  describe("choice saved by earlier builds in the UI-state object", () => {
    it("is adopted once and written to the own key", () => {
      storage.setItem(
        "t3code:ui-state:v1",
        JSON.stringify({ sidebarEnvironmentFilterId: "environment-remote" }),
      );

      expect(readEnvironmentFilter(storage)).toBe("environment-remote");
      // Upstream's next persist rewrites that object without the field.
      storage.setItem("t3code:ui-state:v1", JSON.stringify({ projectOrder: [] }));
      expect(readEnvironmentFilter(storage)).toBe("environment-remote");
    });

    it("loses to the own key once that exists", () => {
      storage.setItem(
        "t3code:ui-state:v1",
        JSON.stringify({ sidebarEnvironmentFilterId: "environment-remote" }),
      );
      storage.setItem(
        ENVIRONMENT_FILTER_STORAGE_KEY,
        JSON.stringify({ selectedEnvironmentId: null }),
      );

      expect(readEnvironmentFilter(storage)).toBeNull();
    });

    it.each([42, "", "   "])("ignores a blank or non-string value of %j", (value) => {
      storage.setItem("t3code:ui-state:v1", JSON.stringify({ sidebarEnvironmentFilterId: value }));

      expect(readEnvironmentFilter(storage)).toBeNull();
      expect(storage.getItem(ENVIRONMENT_FILTER_STORAGE_KEY)).toBeNull();
    });
  });
});
