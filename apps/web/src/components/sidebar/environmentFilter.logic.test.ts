import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  filterToEnvironment,
  isDraftSessionInSidebarScope,
  resolveSidebarEnvironmentFilter,
  sidebarProjectScopeTriggerLabel,
  sidebarSearchEnvironmentIds,
} from "./environmentFilter.logic";

const localEnvironmentId = EnvironmentId.make("environment-local");

describe("resolveSidebarEnvironmentFilter", () => {
  const remoteEnvironmentId = EnvironmentId.make("environment-remote");
  const removedEnvironmentId = EnvironmentId.make("environment-removed");

  it("keeps the selected machine while it is one of several known machines", () => {
    expect(
      resolveSidebarEnvironmentFilter(remoteEnvironmentId, [
        localEnvironmentId,
        remoteEnvironmentId,
      ]),
    ).toBe("environment-remote");
  });

  it("shows all machines when nothing is selected", () => {
    expect(
      resolveSidebarEnvironmentFilter(null, [localEnvironmentId, remoteEnvironmentId]),
    ).toBeNull();
  });

  it("shows all machines when the selected machine is no longer known", () => {
    expect(
      resolveSidebarEnvironmentFilter(removedEnvironmentId, [
        localEnvironmentId,
        remoteEnvironmentId,
      ]),
    ).toBeNull();
  });

  it("shows all machines when only one machine is known", () => {
    expect(resolveSidebarEnvironmentFilter(localEnvironmentId, [localEnvironmentId])).toBeNull();
  });
});

describe("filterToEnvironment", () => {
  const remoteEnvironmentId = EnvironmentId.make("environment-remote");
  const items = [
    { id: "a", environmentId: localEnvironmentId },
    { id: "b", environmentId: remoteEnvironmentId },
    { id: "c", environmentId: localEnvironmentId },
    { id: "d", environmentId: remoteEnvironmentId },
  ];

  it("returns the same list when no machine is selected", () => {
    expect(filterToEnvironment(items, null)).toBe(items);
  });

  it("keeps only the selected machine's items in their original order", () => {
    expect(filterToEnvironment(items, remoteEnvironmentId).map((item) => item.id)).toEqual([
      "b",
      "d",
    ]);
  });

  it("keeps an item from another machine that the caller asks to keep", () => {
    expect(
      filterToEnvironment(items, remoteEnvironmentId, (item) => item.id === "c").map(
        (item) => item.id,
      ),
    ).toEqual(["b", "c", "d"]);
  });
});

describe("sidebarSearchEnvironmentIds", () => {
  const remoteEnvironmentId = EnvironmentId.make("environment-remote");
  const connected = [localEnvironmentId, remoteEnvironmentId];

  it("searches every connected machine when unfiltered", () => {
    expect(sidebarSearchEnvironmentIds(connected, null)).toBe(connected);
  });

  it("searches only the filtered machine while it is connected", () => {
    expect(sidebarSearchEnvironmentIds(connected, remoteEnvironmentId)).toEqual([
      remoteEnvironmentId,
    ]);
  });

  it("searches nothing while the filtered machine is not connected, so search cannot hang", () => {
    expect(sidebarSearchEnvironmentIds([localEnvironmentId], remoteEnvironmentId)).toEqual([]);
  });
});

describe("isDraftSessionInSidebarScope", () => {
  const remoteEnvironmentId = EnvironmentId.make("environment-remote");
  const session = { environmentId: remoteEnvironmentId, projectId: "project-1" };
  const unscoped = { scopedProjectKeys: null, environmentFilterId: null, isRouteDraft: false };

  it("shows every draft when nothing is filtered", () => {
    expect(isDraftSessionInSidebarScope(session, unscoped)).toBe(true);
  });

  it("hides a draft outside the project scope", () => {
    expect(
      isDraftSessionInSidebarScope(session, {
        ...unscoped,
        scopedProjectKeys: new Set(["environment-remote:project-2"]),
      }),
    ).toBe(false);
  });

  it("hides a draft on another machine", () => {
    expect(
      isDraftSessionInSidebarScope(session, {
        ...unscoped,
        environmentFilterId: localEnvironmentId,
      }),
    ).toBe(false);
  });

  it("keeps the open draft visible on another machine", () => {
    expect(
      isDraftSessionInSidebarScope(session, {
        ...unscoped,
        environmentFilterId: localEnvironmentId,
        isRouteDraft: true,
      }),
    ).toBe(true);
  });
});

describe("sidebarProjectScopeTriggerLabel", () => {
  const base = {
    projectScopeKey: null,
    scopedProjectName: null,
    savedProjectName: null,
    environmentFilterLabel: null,
  };

  it("invites filtering when no project is chosen", () => {
    expect(sidebarProjectScopeTriggerLabel(base)).toBe("Filter threads by project");
  });

  it("names the visible scoped project", () => {
    expect(
      sidebarProjectScopeTriggerLabel({
        ...base,
        projectScopeKey: "env:p1",
        scopedProjectName: "tokenmaxxing",
        savedProjectName: "tokenmaxxing",
      }),
    ).toBe("Filter threads by project: tokenmaxxing");
  });

  it("says the saved project filter is paused when the machine filter hides it", () => {
    expect(
      sidebarProjectScopeTriggerLabel({
        ...base,
        projectScopeKey: "env:p1",
        savedProjectName: "tokenmaxxing",
        environmentFilterLabel: "Work box",
      }),
    ).toBe("Project filter paused: tokenmaxxing is not on Work box");
  });

  it("still says paused when the saved project's name is unknown", () => {
    expect(
      sidebarProjectScopeTriggerLabel({
        ...base,
        projectScopeKey: "env:p1",
        environmentFilterLabel: "Work box",
      }),
    ).toBe("Project filter paused: the saved project is not on Work box");
  });
});
