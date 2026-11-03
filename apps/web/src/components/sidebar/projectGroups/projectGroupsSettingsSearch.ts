import type { SettingsSearchItem } from "../../settings/settingsSearch";

/** Search entries for the project-group rows; `settingsSearch.ts` spreads them into its list. */
export const PROJECT_GROUPS_SETTINGS_SEARCH_ITEMS = [
  {
    id: "sidebar-project-groups",
    title: "Group threads by project",
    to: "/settings/general",
    searchTerms: ["fold collapse threads project headers groups sidebar flat list layout"],
  },
  {
    id: "sidebar-float-to-top",
    title: "Float to the top",
    to: "/settings/general",
    searchTerms: [
      "needs you statuses done input approval failed woke limited waiting sidebar groups",
    ],
    requiresSidebarProjectGroups: true,
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
