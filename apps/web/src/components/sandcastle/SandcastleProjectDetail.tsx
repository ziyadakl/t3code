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
  phaseLabel,
  githubIssueUrl,
} from "./sandcastleView.ts";

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

  const active = snap
    ? snap.issues.filter(
        (i) =>
          i.phase !== "merged" &&
          i.phase !== "needs-human" &&
          i.phase !== "deferred",
      )
    : [];
  const recent = snap
    ? snap.issues.filter(
        (i) =>
          i.phase === "merged" ||
          i.phase === "needs-human" ||
          i.phase === "deferred",
      )
    : [];

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
              active.map((i) => {
                const href = issueLink(i.number);
                return (
                  <Card
                    key={i.number}
                    className="flex-row items-center justify-between gap-3 p-3"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        {href ? (
                          <a
                            href={href}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sm font-medium underline"
                          >
                            #{i.number}
                          </a>
                        ) : (
                          <span className="text-sm font-medium">
                            #{i.number}
                          </span>
                        )}
                        <span className="truncate text-sm">{i.title}</span>
                      </div>
                      {i.detail ? (
                        <span className="text-xs text-muted-foreground">
                          {i.detail}
                        </span>
                      ) : null}
                    </div>
                    <Badge
                      variant={i.attention ? "warning" : "secondary"}
                      size="sm"
                    >
                      {phaseLabel(i.phase)}
                    </Badge>
                  </Card>
                );
              })
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">Recent</h2>
            {recent.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Nothing finished yet.
              </p>
            ) : (
              recent.map((i) => {
                const href = issueLink(i.number);
                return (
                  <div
                    key={i.number}
                    className="flex items-center justify-between gap-3 px-1 py-1 text-sm"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      {href ? (
                        <a
                          href={href}
                          target="_blank"
                          rel="noreferrer"
                          className="font-medium underline"
                        >
                          #{i.number}
                        </a>
                      ) : (
                        <span className="font-medium">#{i.number}</span>
                      )}
                      <span className="truncate text-muted-foreground">
                        {i.title}
                      </span>
                    </div>
                    <Badge variant="secondary" size="sm">
                      {phaseLabel(i.phase)}
                    </Badge>
                  </div>
                );
              })
            )}
          </section>
        </>
      )}
    </div>
  );
}
