import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

describe("ServerSettings thread auto-archive", () => {
  it("archives settled threads after seven days by default, and can be turned off", () => {
    expect(decodeServerSettings({}).sidebarAutoArchiveSettledAfterDays).toBe(7);
    expect(
      decodeServerSettings({ sidebarAutoArchiveSettledAfterDays: null })
        .sidebarAutoArchiveSettledAfterDays,
    ).toBeNull();
    expect(decodeServerSettingsPatch({ sidebarAutoArchiveSettledAfterDays: 14 })).toMatchObject({
      sidebarAutoArchiveSettledAfterDays: 14,
    });
    expect(() => decodeServerSettings({ sidebarAutoArchiveSettledAfterDays: 0 })).toThrow();
  });
});
