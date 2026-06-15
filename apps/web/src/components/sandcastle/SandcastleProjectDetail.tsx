// apps/web/src/components/sandcastle/SandcastleProjectDetail.tsx
import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import { useStore, selectProjectsAcrossEnvironments } from "../../store.ts";
import { Badge } from "../ui/badge.tsx";
import { Card } from "../ui/card.tsx";
import {
  useSandcastleStatuses,
  statusKey,
  type ProjectRef,
} from "./useSandcastleStatuses.ts";
import {
  deriveBanner,
  bannerTone,
  githubIssueUrl,
  partitionIssuesByPhase,
  finishedRunAgeHint,
} from "./sandcastleView.ts";
import { SandcastleIssueRow } from "./SandcastleIssueRow.tsx";

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
              <Badge variant="success" size="sm">
                ✓ {snap.totals.merged} merged
              </Badge>
              <Badge variant="warning" size="sm">
                ⚠ {snap.totals.needsHuman} needs you
              </Badge>
              <Badge variant="secondary" size="sm">
                ↻ {snap.totals.requeued} requeued
              </Badge>
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
