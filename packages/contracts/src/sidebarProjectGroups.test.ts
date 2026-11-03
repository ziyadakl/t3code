import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ClientSettingsPatch, ClientSettingsSchema } from "./settings.ts";
import {
  applyClientSettingsPatch,
  resolveSidebarFloatToTopStatusSet,
} from "./sidebarProjectGroups.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);

describe("ClientSettings sidebar project groups", () => {
  it("turns the grouped layout on and floats the statuses that need the user by default", () => {
    const settings = decodeClientSettings({});

    expect(settings.sidebarProjectGroupsEnabled).toBe(true);
    expect(settings.sidebarFloatToTopStatuses).toEqual({
      done: true,
      input: true,
      approval: true,
      failed: true,
      woke: false,
      limited: false,
      waiting: false,
    });
  });

  it("fills statuses missing from a saved float list with their defaults", () => {
    const settings = decodeClientSettings({
      sidebarFloatToTopStatuses: { woke: true, failed: false },
    });

    expect(settings.sidebarFloatToTopStatuses).toEqual({
      done: true,
      input: true,
      approval: true,
      failed: false,
      woke: true,
      limited: false,
      waiting: false,
    });
  });

  it("preserves an opt-out of the grouped layout through patches and persistence", () => {
    const preference = { sidebarProjectGroupsEnabled: false };
    expect(decodeClientSettingsPatch(preference)).toEqual(preference);
    expect(encodeClientSettings(decodeClientSettings(preference))).toMatchObject(preference);
  });

  it("accepts a float list update as a patch", () => {
    const statuses = {
      done: false,
      input: true,
      approval: true,
      failed: true,
      woke: true,
      limited: false,
      waiting: false,
    };
    expect(decodeClientSettingsPatch({ sidebarFloatToTopStatuses: statuses })).toEqual({
      sidebarFloatToTopStatuses: statuses,
    });
  });
  it("keeps the saved value of every status a float list patch leaves out", () => {
    const current = decodeClientSettings({
      sidebarFloatToTopStatuses: { woke: true, input: false },
    });
    const patch = decodeClientSettingsPatch({ sidebarFloatToTopStatuses: { done: false } });

    expect(applyClientSettingsPatch(current, patch).sidebarFloatToTopStatuses).toEqual({
      done: false,
      input: false,
      approval: true,
      failed: true,
      woke: true,
      limited: false,
      waiting: false,
    });
  });

  it("replaces other settings from a patch as before", () => {
    const current = decodeClientSettings({});
    const next = applyClientSettingsPatch(current, { sidebarProjectGroupsEnabled: false });

    expect(next.sidebarProjectGroupsEnabled).toBe(false);
    expect(next.sidebarFloatToTopStatuses).toEqual(current.sidebarFloatToTopStatuses);
  });
});

describe("resolveSidebarFloatToTopStatusSet", () => {
  it("returns only the statuses switched on", () => {
    const { sidebarFloatToTopStatuses } = decodeClientSettings({
      sidebarFloatToTopStatuses: { woke: true, failed: false },
    });

    expect([...resolveSidebarFloatToTopStatusSet(sidebarFloatToTopStatuses)].toSorted()).toEqual([
      "approval",
      "done",
      "input",
      "woke",
    ]);
  });
});
