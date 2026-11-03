import type { SettingsSearchItem } from "./settingsSearch";

/** Search entries for the auto-archive rows; `settingsSearch.ts` spreads them into its list. */
export const AUTO_ARCHIVE_SETTINGS_SEARCH_ITEMS = [
  {
    id: "auto-archive-settled-threads",
    title: "Auto-archive settled threads",
    to: "/settings/general",
    searchTerms: ["sidebar archive cleanup old settled helper subagent automatically"],
    requiresThreadAutoArchive: true,
  },
  {
    id: "days-before-auto-archive",
    title: "Days settled before auto-archive",
    to: "/settings/general",
    targetId: "auto-archive-settled-threads",
    searchTerms: ["thread archive timeout sidebar"],
    requiresThreadAutoArchive: true,
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
