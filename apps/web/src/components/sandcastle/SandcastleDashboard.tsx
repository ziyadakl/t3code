// apps/web/src/components/sandcastle/SandcastleDashboard.tsx
import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { EnvironmentId, SandcastleStatusSnapshot } from "@t3tools/contracts";
import { useStore, selectProjectsAcrossEnvironments } from "../../store.ts";
import { useSavedEnvironmentRegistryStore } from "../../environments/runtime";
import { useUiStateStore } from "../../uiStateStore.ts";
import { Badge } from "../ui/badge.tsx";
import { Card } from "../ui/card.tsx";
import { LiveDot } from "./LiveDot.tsx";
import { useSandcastleStatuses, statusKey, type ProjectRef } from "./useSandcastleStatuses.ts";
import {
  deriveBanner,
  bannerTone,
  finishedRunAgeHint,
  groupSandcastleRows,
  queueReadyDisplay,
  pillVariant,
  sumTotalsAcrossHosts,
} from "./sandcastleView.ts";
import { SANDCASTLE_PILLS, pillIcon, type StatusPillSpec } from "./statusPills.tsx";

/** A status count badge: muted (gray) while its count is zero, taking its
 *  meaningful color once non-zero (so "0" doesn't read as a green success). */
function CountBadge({ spec, count }: { spec: StatusPillSpec; count: number }) {
  return (
    <Badge variant={pillVariant(count, spec.variant)} size="xl">
      {pillIcon(spec, count)}
      <span>{count}</span>
    </Badge>
  );
}

/** The running/merged/needs-you count pills for a live snapshot. Fusing the
 *  totals here — inside a non-null `snap` boundary — lets TS narrow the per-spec
 *  index so no non-null assertion is needed. No peers ⇒ own totals unchanged. */
function SnapshotTotalsPills({ snap }: { snap: SandcastleStatusSnapshot }) {
  const fusedTotals = sumTotalsAcrossHosts(snap);
  return (
    <>
      {[SANDCASTLE_PILLS.running, SANDCASTLE_PILLS.merged, SANDCASTLE_PILLS.needsHuman].map(
        (spec) => (
          <CountBadge key={spec.key} spec={spec} count={fusedTotals[spec.key]} />
        ),
      )}
    </>
  );
}

function EnvLabel({ environmentId }: { environmentId: EnvironmentId }) {
  const label = useSavedEnvironmentRegistryStore((s) => s.byId[environmentId]?.label ?? "Local");
  return <span className="text-xs text-muted-foreground">{label}</span>;
}

type DashboardProject = ReturnType<typeof selectProjectsAcrossEnvironments>[number];
type SandcastleStatusValue = ReturnType<ReturnType<typeof useSandcastleStatuses>["get"]>;
interface DashboardRow {
  project: DashboardProject;
  value: SandcastleStatusValue;
}

/** One project card. Shared verbatim by the Running and Idle groups so the card
 *  markup lives in exactly one place. */
function SandcastleProjectCard({ project, value }: DashboardRow) {
  const entry = value!.entry;
  const banner = deriveBanner(entry, value!.serverNow);
  const snap = entry.snapshot;
  const ageHint = snap ? finishedRunAgeHint(snap.state, snap.updatedAt, value!.serverNow) : null;
  const queueReady = queueReadyDisplay(entry.queueReady);
  return (
    <Link
      to="/sandcastle/$environmentId/$projectId"
      params={{
        environmentId: project.environmentId,
        projectId: project.id,
      }}
      className="block outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-2xl"
    >
      <Card className="flex-row items-center justify-between gap-4 p-4 transition-colors hover:bg-accent/40">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{project.name}</span>
            <EnvLabel environmentId={project.environmentId} />
          </div>
          {snap ? (
            <span className="truncate text-xs text-muted-foreground">
              iter {snap.run.iterations.current}/{snap.run.iterations.total} · {snap.run.branch}
              {ageHint ? ` · updated ${ageHint}` : ""}
            </span>
          ) : null}
          {queueReady ? (
            <span
              className={`truncate text-xs ${
                queueReady.muted ? "text-muted-foreground/60" : "text-muted-foreground"
              }`}
              title={queueReady.title}
            >
              {queueReady.text}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {snap ? <SnapshotTotalsPills snap={snap} /> : null}
          <Badge variant={bannerTone(banner.kind)} size="xl">
            {banner.kind === "live" ? <LiveDot /> : null}
            {banner.text}
          </Badge>
        </div>
      </Card>
    </Link>
  );
}

function rowKey(row: DashboardRow): string {
  return `${row.project.environmentId}-${row.project.id}`;
}

export function SandcastleDashboard() {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const idleCollapsed = useUiStateStore((s) => s.sandcastleIdleCollapsed);
  const toggleIdleCollapsed = useUiStateStore((s) => s.toggleSandcastleIdleCollapsed);

  const refs = useMemo<ProjectRef[]>(
    () => projects.map((p) => ({ environmentId: p.environmentId, cwd: p.cwd })),
    [projects],
  );
  const statuses = useSandcastleStatuses(refs);

  // Only show Sandcastle-enabled projects (those with a .sandcastle/ dir).
  const rows: DashboardRow[] = projects
    .map((p) => ({
      project: p,
      value: statuses.get(statusKey(p.environmentId, p.cwd)),
    }))
    .filter((r) => r.value?.entry.hasSandcastleDir);

  // Running (actively looping) on top, most-recent first; idle collapsible below.
  const groups = groupSandcastleRows(
    rows.map((row) => ({
      item: row,
      state: row.value?.entry.snapshot?.state ?? null,
      updatedAt: row.value?.entry.snapshot?.updatedAt ?? null,
    })),
  );
  const showDivider = groups.running.length > 0 && groups.idle.length > 0;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col gap-4 overflow-auto px-16 py-6">
      <header className="mx-auto flex w-full max-w-5xl items-baseline justify-between px-4">
        <h1 className="text-lg font-semibold">Sandcastle</h1>
        <span className="text-xs text-muted-foreground">
          {rows.length} project{rows.length === 1 ? "" : "s"}
        </span>
      </header>

      {rows.length === 0 ? (
        <p className="mx-auto w-full max-w-5xl text-sm text-muted-foreground">
          No Sandcastle runs found. Projects appear here once they have a
          <code className="mx-1 rounded bg-muted px-1 py-0.5">.sandcastle/</code>
          directory.
        </p>
      ) : (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-3">
          {groups.running.length > 0 ? (
            <div className="grid gap-3">
              {groups.running.map((row) => (
                <SandcastleProjectCard key={rowKey(row)} project={row.project} value={row.value} />
              ))}
            </div>
          ) : null}

          {showDivider ? (
            <div
              role="separator"
              aria-orientation="horizontal"
              className="mt-4 h-px bg-linear-to-r from-transparent via-foreground/10 to-transparent"
            />
          ) : null}

          {groups.idle.length > 0 ? (
            <div className="flex flex-col gap-3">
              <button
                type="button"
                onClick={() => toggleIdleCollapsed()}
                aria-expanded={!idleCollapsed}
                className="flex w-fit items-center gap-1.5 rounded text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronRightIcon
                  className={`-ml-0.5 size-3.5 shrink-0 transition-transform duration-150 ${
                    idleCollapsed ? "" : "rotate-90"
                  }`}
                />
                <span>Idle</span>
                <span className="text-muted-foreground/60">{groups.idle.length}</span>
              </button>
              {idleCollapsed ? null : (
                <div className="grid gap-3">
                  {groups.idle.map((row) => (
                    <SandcastleProjectCard
                      key={rowKey(row)}
                      project={row.project}
                      value={row.value}
                    />
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
