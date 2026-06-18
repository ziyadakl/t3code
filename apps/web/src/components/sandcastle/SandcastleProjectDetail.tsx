// apps/web/src/components/sandcastle/SandcastleProjectDetail.tsx
import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import { useStore, selectProjectsAcrossEnvironments } from "../../store.ts";
import { Badge, badgeVariants } from "../ui/badge.tsx";
import { Card } from "../ui/card.tsx";
import {
  Popover,
  PopoverContent,
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
} from "./sandcastleView.ts";
import { SandcastleIssueRow } from "./SandcastleIssueRow.tsx";
import type { HistoryLinkRow } from "./sandcastleView.ts";
import type { VariantProps } from "class-variance-authority";

/** Clickable pill that opens a popover listing the history entries for a phase. */
function PillPopover({
  variant,
  label,
  rows,
}: {
  variant: NonNullable<VariantProps<typeof badgeVariants>["variant"]>;
  label: string;
  rows: HistoryLinkRow[];
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={badgeVariants({ variant, size: "sm" })}
            aria-label={`${label} — click to see details`}
          />
        }
      >
        {label}
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-72">
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
      </PopoverContent>
    </Popover>
  );
}

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
    <div className="flex h-full flex-col gap-4 overflow-auto p-6">
      <header className="flex items-center gap-3">
        <Link
          to="/sandcastle"
          className="text-sm text-muted-foreground underline"
        >
          ← Sandcastle
        </Link>
        <h1 className="text-lg font-semibold">{project.name}</h1>
        {banner ? (
          <Badge variant={bannerTone(banner.kind)} size="sm">
            {banner.text}
          </Badge>
        ) : null}
        {ageHint ? (
          <span className="text-xs text-muted-foreground">
            Updated {ageHint}
          </span>
        ) : null}
      </header>

      {!snap ? (
        <p className="text-sm text-muted-foreground">
          {banner?.text ?? "No run data."}
        </p>
      ) : (
        <>
          <Card className="flex-row flex-wrap items-center gap-3 p-4 text-sm">
            <span className="text-muted-foreground">
              iter {snap.run.iterations.current}/{snap.run.iterations.total}
            </span>
            <span className="text-muted-foreground">{snap.run.branch}</span>
            {snap.activity ? (
              <Badge variant="info" size="sm">
                {snap.activity}…
              </Badge>
            ) : null}
            <div className="ms-auto flex gap-2">
              <PillPopover
                variant="success"
                label={`✓ ${snap.totals.merged} merged`}
                rows={historyLinksForPhase(
                  snap.history,
                  "merged",
                  project.repositoryIdentity ?? null,
                )}
              />
              <PillPopover
                variant="warning"
                label={`⚠ ${snap.totals.needsHuman} needs you`}
                rows={historyLinksForPhase(
                  snap.history,
                  "needs-human",
                  project.repositoryIdentity ?? null,
                )}
              />
              <PillPopover
                variant="secondary"
                label={`↻ ${snap.totals.requeued} requeued`}
                rows={historyLinksForPhase(
                  snap.history,
                  "deferred",
                  project.repositoryIdentity ?? null,
                )}
              />
              <Badge variant="info" size="sm">
                ▶ {snap.totals.running} running
              </Badge>
            </div>
          </Card>

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
        </>
      )}
    </div>
  );
}
