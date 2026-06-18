// apps/web/src/components/sandcastle/statusPills.tsx
import type { ReactNode } from "react";
import {
  CheckIcon,
  GitMergeIcon,
  PlayIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import type { PillVariant } from "./sandcastleView.ts";

/** Which `totals` field a status pill counts. */
export type PillKey = "running" | "merged" | "needsHuman" | "requeued";

/**
 * Fixed visual identity of a status count pill, shared by the dashboard cards
 * and the project-detail view so the icon/word/color live in exactly one place.
 * `ActiveIcon` overrides `Icon` once the count is non-zero — the merged pill
 * turns from a merge glyph into a check, so "0 merged" never looks like
 * something already merged.
 */
export interface StatusPillSpec {
  readonly key: PillKey;
  readonly word: string;
  readonly variant: PillVariant;
  readonly Icon: LucideIcon;
  readonly ActiveIcon?: LucideIcon;
}

export const SANDCASTLE_PILLS = {
  running: { key: "running", word: "running", variant: "info", Icon: PlayIcon },
  merged: {
    key: "merged",
    word: "merged",
    variant: "success",
    Icon: GitMergeIcon,
    ActiveIcon: CheckIcon,
  },
  needsHuman: {
    key: "needsHuman",
    word: "needs you",
    variant: "warning",
    Icon: TriangleAlertIcon,
  },
  requeued: {
    key: "requeued",
    word: "requeued",
    variant: "secondary",
    Icon: RotateCcwIcon,
  },
} satisfies Record<PillKey, StatusPillSpec>;

/** The icon a pill shows for `count`: its active icon once non-zero (when it
 *  has one), otherwise its default icon. */
export function pillIcon(spec: StatusPillSpec, count: number): ReactNode {
  const Icon = count > 0 && spec.ActiveIcon ? spec.ActiveIcon : spec.Icon;
  return <Icon />;
}
