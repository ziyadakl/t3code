// apps/web/src/components/sandcastle/SandcastleIssueRow.tsx
import type { SandcastleIssuePhase } from "@t3tools/contracts";
import { Badge } from "../ui/badge.tsx";
import { Card } from "../ui/card.tsx";
import { phaseLabel } from "./sandcastleView.ts";

/** The minimal issue shape this row renders — satisfied by both a live
 *  `SandcastleStatusIssue` (Active) and a `RecentFinishedRow` (Recent). */
interface IssueRowData {
  readonly number: number;
  readonly title: string;
  readonly phase: SandcastleIssuePhase;
  readonly detail?: string | undefined;
  readonly attention?: boolean | undefined;
}

/**
 * One issue row in the Sandcastle project detail view. Shared between the
 * "Active" and "Recent" sections, which differ only in wrapper element,
 * classNames, whether the optional detail line shows, and badge variant.
 * The Recent variant may show a relative completion `age` (e.g. "5m ago").
 */
export function SandcastleIssueRow({
  issue: i,
  href,
  variant,
  age,
  hostLabel,
}: {
  issue: IssueRowData;
  href: string | null;
  variant: "active" | "recent";
  age?: string | null;
  /** When set (multi-host fused view), tag the row with a small host badge.
   *  Omitted ⇒ the row renders byte-for-byte as a single-host row. */
  hostLabel?: string | undefined;
}) {
  const numberClass = variant === "active" ? "text-sm font-medium" : "font-medium";
  const number = href ? (
    <a href={href} target="_blank" rel="noreferrer" className={`${numberClass} underline`}>
      #{i.number}
    </a>
  ) : (
    <span className={numberClass}>#{i.number}</span>
  );
  const hostBadge = hostLabel ? (
    <Badge variant="outline" size="sm">
      {hostLabel}
    </Badge>
  ) : null;

  if (variant === "active") {
    return (
      <Card className="flex-row items-center justify-between gap-3 p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {number}
            {hostBadge}
            <span className="truncate text-sm">{i.title}</span>
          </div>
          {i.detail ? <span className="text-xs text-muted-foreground">{i.detail}</span> : null}
        </div>
        <Badge variant={i.attention ? "warning" : "secondary"} size="sm">
          {phaseLabel(i.phase)}
        </Badge>
      </Card>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 px-1 py-1 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        {number}
        {hostBadge}
        <span className="truncate text-muted-foreground">{i.title}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {age ? <span className="text-xs text-muted-foreground">{age}</span> : null}
        <Badge variant="secondary" size="sm">
          {phaseLabel(i.phase)}
        </Badge>
      </div>
    </div>
  );
}
