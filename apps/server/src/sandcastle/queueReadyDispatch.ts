/**
 * queueReadyDispatch — a pure replication of the Sandcastle loop's dispatch
 * selector so the viewer's "queue-ready" count reflects exactly the issues the
 * loop's planner will actually pick up, not every open issue carrying the pickup
 * label.
 *
 * Given the open issues carrying the pickup label, two rules narrow them to the
 * dispatchable set:
 *
 *   1. type: rule — when `SANDCASTLE.md` exists at the repo root, keep only
 *      issues carrying EXACTLY ONE label whose name starts with the literal
 *      `"type:"` (case-sensitive). Zero or more than one `type:` labels ⇒
 *      excluded. When `SANDCASTLE.md` does not exist the rule is skipped (keep
 *      all). Source: ~/Dev/Sandcastle/.sandcastle/lib/skill-discipline.ts:271-288,
 *      ~/Dev/Sandcastle/.sandcastle/main.mts:4210-4211.
 *
 *   2. blocked-by rule — exclude any issue whose body declares `Blocked by: #N`
 *      for an `N` that is still OPEN (present in the repo's open-issue set). A
 *      blocker counts as resolved only when CLOSED (absent from the open set),
 *      regardless of its labels. Source: ~/Dev/Sandcastle/.sandcastle/main.mts:2376-2426.
 *
 * Pure — no Effect, no IO — so it is fully unit-testable. The caller performs
 * the IO (the `gh` queries and the SANDCASTLE.md existence check) and feeds the
 * results in here.
 */

/**
 * Mirrors ~/Dev/Sandcastle/.sandcastle/main.mts parseBlockedBy — keep in sync.
 *
 * Extracts the `#N` issue references declared on a `Blocked by: …` line. The
 * colon is REQUIRED; only `#N` tokens on the SAME LINE as the directive are
 * captured (next-line references are ignored); the directive match is
 * case-insensitive and tolerates `-`/whitespace between "blocked" and "by".
 */
export function parseBlockedBy(body: string): number[] {
  if (typeof body !== "string" || body.length === 0) return [];
  const found = new Set<number>();
  const directive = /blocked[\s-]*by\s*:\s*([^\n\r]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = directive.exec(body)) !== null) {
    const rest = m[1] ?? "";
    const refs = rest.matchAll(/#(\d+)/g);
    for (const ref of refs) {
      const n = Number(ref[1]);
      if (Number.isInteger(n) && n > 0) found.add(n);
    }
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Count the issues the Sandcastle planner would dispatch right now, applying the
 * type: and blocked-by rules to the ready set. See the module header for the
 * rule definitions and their sources.
 */
export function countDispatchableIssues(input: {
  ready: ReadonlyArray<{ number: number; body: string; labels: readonly string[] }>;
  openNumbers: ReadonlyArray<number>;
  sandcastleMdExists: boolean;
}): number {
  const openSet = new Set(input.openNumbers);
  return input.ready.filter(
    (issue) =>
      (!input.sandcastleMdExists ||
        issue.labels.filter((l) => l.startsWith("type:")).length === 1) &&
      parseBlockedBy(issue.body).every((n) => !openSet.has(n)),
  ).length;
}
