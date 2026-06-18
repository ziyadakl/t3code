// apps/web/src/components/sandcastle/SandcastleProjectDetail.tsx
import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import { useStore, selectProjectsAcrossEnvironments } from "../../store.ts";
import { Badge, badgeVariants } from "../ui/badge.tsx";
import { Card } from "../ui/card.tsx";
import { Separator } from "../ui/separator.tsx";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "../ui/popover.tsx";
import {
  useSandcastleStatuses,
  statusKey,
  type ProjectRef,
} from "./useSandcastleStatuses.ts";
import {
  deriveBanner,
  bannerTone,
  githubIssueUrl,
  historyLinksForPhase,
  partitionIssuesByPhase,
  finishedRunAgeHint,
  pillVariant,
} from "./sandcastleView.ts";
import { SandcastleIssueRow } from "./SandcastleIssueRow.tsx";
import { LiveDot } from "./LiveDot.tsx";
import {
  SANDCASTLE_PILLS,
  pillIcon,
  type StatusPillSpec,
} from "./statusPills.tsx";
import type { SandcastleIssuePhase } from "@t3tools/contracts";
import type { HistoryLinkRow } from "./sandcastleView.ts";

/** Clickable pill that opens a popover listing the history entries for a phase. */
function PillPopover({
  spec,
  count,
  rows,
}: {
  spec: StatusPillSpec;
  count: number;
  rows: HistoryLinkRow[];
}) {
  const srLabel = `${count} ${spec.word}`;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={badgeVariants({
              variant: pillVariant(count, spec.variant),
              size: "xl",
            })}
            aria-label={`${srLabel}, view history`}
          />
        }
      >
        {pillIcon(spec, count)}
        <span>
          {count} {spec.word}
        </span>
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" className="w-72">
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing recorded yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {rows.map((row, i) => (
              // Duplicates are intentional (same issue can appear twice in history);
              // no reordering/removal in this read-only popover list, so index key is correct.
              // oxlint-disable-next-line react/no-array-index-key
              <li key={`${row.number}-${i}`} className="flex gap-1.5 text-xs">
                {row.href ? (
                  <a
                    href={row.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium underline underline-offset-2"
                  >
                    #{row.number}
                  </a>
                ) : (
                  <span className="font-medium">#{row.number}</span>
                )}
                <span className="truncate text-muted-foreground">{row.title}</span>
              </li>
            ))}
          </ul>
        )}
      </PopoverPopup>
    </Popover>
  );
}

/**
 * The detail pills that open a history popover, paired with the history phase
 * each lists. NOTE: there is no "requeued" history phase — requeued is a
 * totals-only concept (issues released back to the queue). The popover falls
 * back to "deferred", the closest phase, but requeued ≠ deferred; revisit once
 * the loop writes a dedicated phase (sandcastle-loop PR #14).
 */
const DETAIL_POPOVER_PILLS: ReadonlyArray<{
  spec: StatusPillSpec;
  phase: SandcastleIssuePhase;
}> = [
  { spec: SANDCASTLE_PILLS.merged, phase: "merged" },
  { spec: SANDCASTLE_PILLS.needsHuman, phase: "needs-human" },
  { spec: SANDCASTLE_PILLS.requeued, phase: "deferred" },
];

export function SandcastleProjectDetail({
  environmentId,
  projectId,
}: {
  environmentId: string;
  projectId: string;
}) {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const project = projects.find(
    (p) => p.environmentId === environmentId && p.id === projectId,
  );

  const refs = useMemo<ProjectRef[]>(
    () =>
      project
        ? [{ environmentId: project.environmentId, cwd: project.cwd }]
        : [],
    [project],
  );
  const statuses = useSandcastleStatuses(refs);

  if (!project) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Project not found.{" "}
        <Link to="/sandcastle" className="underline">
          Back to dashboard
        </Link>
      </div>
    );
  }

  const value = statuses.get(statusKey(project.environmentId, project.cwd));
  const entry = value?.entry;
  const banner = entry ? deriveBanner(entry, value!.serverNow) : null;
  const snap = entry?.snapshot ?? null;
  const ageHint = snap
    ? finishedRunAgeHint(snap.state, snap.updatedAt, value!.serverNow)
    : null;

  const { active, recent } = partitionIssuesByPhase(snap?.issues ?? []);

  const issueLink = (n: number) =>
    githubIssueUrl(project.repositoryIdentity ?? null, n);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden px-16 py-6">
      <header className="mx-auto flex w-full max-w-5xl shrink-0 items-center gap-3">
        <Link
          to="/sandcastle"
          className="text-sm text-muted-foreground underline"
        >
          ← Sandcastle
        </Link>
        <h1 className="text-lg font-semibold">{project.name}</h1>
        <div className="ms-auto me-4 flex items-center gap-3">
          {ageHint ? (
            <span className="text-xs text-muted-foreground">
              Updated {ageHint}
            </span>
          ) : null}
          {banner ? (
            <Badge variant={bannerTone(banner.kind)} size="xl">
              {banner.kind === "live" ? <LiveDot /> : null}
              {banner.text}
              {banner.kind === "live" && snap?.activity ? (
                <span className="font-normal opacity-70">
                  · {snap.activity}…
                </span>
              ) : null}
            </Badge>
          ) : null}
        </div>
      </header>

      {!snap ? (
        <p className="mx-auto w-full max-w-5xl text-sm text-muted-foreground">
          {banner?.text ?? "No run data."}
        </p>
      ) : (
        <>
          <Card className="mx-auto w-full max-w-5xl shrink-0 flex-row flex-wrap items-center gap-3 px-4 py-6 text-sm">
            <span className="text-muted-foreground">
              {snap.run.iterations.current}/{snap.run.iterations.total}
            </span>
            <span className="text-muted-foreground">{snap.run.branch}</span>
            <div className="ms-auto flex gap-2">
              {DETAIL_POPOVER_PILLS.map(({ spec, phase }) => (
                <PillPopover
                  key={spec.key}
                  spec={spec}
                  count={snap.totals[spec.key]}
                  rows={historyLinksForPhase(
                    snap.history,
                    phase,
                    project.repositoryIdentity ?? null,
                  )}
                />
              ))}
            </div>
          </Card>

          <Card className="mx-auto w-full max-w-5xl min-h-0 gap-4 overflow-y-auto p-4">
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">Active</h2>
              {active.length === 0 ? (
                <p className="text-xs text-muted-foreground">No active issues.</p>
              ) : (
                active.map((i) => (
                  <SandcastleIssueRow
                    key={i.number}
                    variant="active"
                    issue={i}
                    href={issueLink(i.number)}
                  />
                ))
              )}
            </section>

            <Separator className="data-[orientation=horizontal]:h-0.5" />

            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">Recent</h2>
              {recent.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Nothing finished yet.
                </p>
              ) : (
                recent.map((i) => (
                  <SandcastleIssueRow
                    key={i.number}
                    variant="recent"
                    issue={i}
                    href={issueLink(i.number)}
                  />
                ))
              )}
            </section>
          </Card>
        </>
      )}
    </div>
  );
}
