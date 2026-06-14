// apps/web/src/components/sandcastle/useSandcastleStatuses.ts
import { useEffect, useRef, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { SandcastleStatusEntry } from "@t3tools/contracts";
import { readEnvironmentApi } from "../../environmentApi.ts";

const POLL_MS = 2000;

export interface SandcastleStatusValue {
  readonly environmentId: EnvironmentId;
  readonly entry: SandcastleStatusEntry;
  readonly serverNow: string;
}

/** key = `${environmentId}::${cwd}` */
export type SandcastleStatusMap = ReadonlyMap<string, SandcastleStatusValue>;

export function statusKey(environmentId: EnvironmentId, cwd: string): string {
  return `${environmentId}::${cwd}`;
}

export interface ProjectRef {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

export function useSandcastleStatuses(
  projects: ReadonlyArray<ProjectRef>,
): SandcastleStatusMap {
  const [map, setMap] = useState<SandcastleStatusMap>(new Map());

  // Group cwds by environment; serialize so the effect only re-subscribes when
  // the actual set changes (not on every render's new array identity).
  const grouped = new Map<EnvironmentId, string[]>();
  for (const p of projects) {
    const list = grouped.get(p.environmentId) ?? [];
    list.push(p.cwd);
    grouped.set(p.environmentId, list);
  }
  const signature = JSON.stringify(
    [...grouped.entries()].map(([env, cwds]) => [env, [...cwds].sort()]).sort(),
  );

  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    const pollOnce = () => {
      for (const [environmentId, cwds] of grouped.entries()) {
        const api = readEnvironmentApi(environmentId);
        if (!api) continue;
        void api.sandcastle
          .statusAll({ cwds })
          .then((res) => {
            if (cancelledRef.current) return;
            setMap((prev) => {
              const next = new Map(prev);
              for (const entry of res.entries) {
                next.set(statusKey(environmentId, entry.cwd), {
                  environmentId,
                  entry,
                  serverNow: res.serverNow,
                });
              }
              return next;
            });
          })
          .catch(() => undefined);
      }
    };

    pollOnce();
    const id = window.setInterval(pollOnce, POLL_MS);
    return () => {
      cancelledRef.current = true;
      window.clearInterval(id);
    };
    // grouped is derived from `signature`; re-run only when the set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return map;
}
