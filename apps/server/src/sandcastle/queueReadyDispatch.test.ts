import { describe, it, expect } from "@effect/vitest";

import type { DispatchReadyIssue } from "../sourceControl/GitHubCli.ts";
import {
  countDispatchableIssues,
  parseBlockedBy,
  readyHasBlockers,
} from "./queueReadyDispatch.ts";

describe("parseBlockedBy", () => {
  it("requires the colon — `Blocked by #5` (no colon) is not a directive", () => {
    expect(parseBlockedBy("Blocked by #5")).toEqual([]);
  });

  it("matches the canonical `Blocked by: #N` form", () => {
    expect(parseBlockedBy("Blocked by: #5")).toEqual([5]);
  });

  it("matches the hyphenated `Blocked-by:` variant", () => {
    expect(parseBlockedBy("Blocked-by: #7")).toEqual([7]);
  });

  it("tolerates extra spacing around the directive and colon", () => {
    expect(parseBlockedBy("blocked   by   :   #9")).toEqual([9]);
  });

  it("is case-insensitive on the directive", () => {
    expect(parseBlockedBy("BLOCKED BY: #11")).toEqual([11]);
  });

  it("stacks multiple references on the same line", () => {
    expect(parseBlockedBy("Blocked by: #3, #1 and #2")).toEqual([1, 2, 3]);
  });

  it("ignores `#N` references on the NEXT line (only the directive line is swept)", () => {
    // #5 is on the directive line and captured; #6 on the next line is ignored
    // because the `([^\n\r]*)` sweep stops at the newline.
    expect(parseBlockedBy("Blocked by: #5\n#6")).toEqual([5]);
  });

  it("greedily crosses a newline only when the colon is immediately followed by one", () => {
    // Degenerate case: with no content after the colon on the directive line,
    // the `\s*` after the colon consumes the newline, so the next line is swept.
    expect(parseBlockedBy("Blocked by:\n#5")).toEqual([5]);
  });

  it("captures across multiple directive lines", () => {
    expect(parseBlockedBy("Blocked by: #5\nsome text\nblocked by: #8")).toEqual([5, 8]);
  });

  it("dedupes repeated references and sorts ascending", () => {
    expect(parseBlockedBy("Blocked by: #8, #8, #2")).toEqual([2, 8]);
  });

  it("returns [] for an empty body", () => {
    expect(parseBlockedBy("")).toEqual([]);
  });

  it("returns [] for a non-string body", () => {
    expect(parseBlockedBy(undefined as unknown as string)).toEqual([]);
    expect(parseBlockedBy(null as unknown as string)).toEqual([]);
  });

  it("ignores `#0` and non-positive references", () => {
    expect(parseBlockedBy("Blocked by: #0")).toEqual([]);
  });
});

describe("readyHasBlockers", () => {
  const issue = (body: string): DispatchReadyIssue => ({ number: 1, body, labels: [] });

  it("is true when any ready issue declares `Blocked by: #N`", () => {
    expect(readyHasBlockers([issue(""), issue("Blocked by: #5")])).toBe(true);
  });

  it("is false when no ready issue declares a blocker", () => {
    expect(readyHasBlockers([issue(""), issue("just a normal body, no directive")])).toBe(false);
  });

  it("is false for an empty ready set", () => {
    expect(readyHasBlockers([])).toBe(false);
  });

  it("ignores a `Blocked by` missing the required colon (not a directive)", () => {
    expect(readyHasBlockers([issue("Blocked by #5")])).toBe(false);
  });
});

describe("countDispatchableIssues", () => {
  const issue = (
    number: number,
    over: { body?: string; labels?: readonly string[] } = {},
  ): DispatchReadyIssue => ({
    number,
    body: over.body ?? "",
    labels: over.labels ?? [],
  });

  describe("type: rule (SANDCASTLE.md absent ⇒ skipped)", () => {
    it("counts every ready issue, even typeless or multi-type", () => {
      const ready = [
        issue(1, { labels: [] }),
        issue(2, { labels: ["type:feature"] }),
        issue(3, { labels: ["type:feature", "type:bug"] }),
      ];
      expect(
        countDispatchableIssues({ ready, openNumbers: [1, 2, 3], sandcastleMdExists: false }),
      ).toBe(3);
    });
  });

  describe("type: rule (SANDCASTLE.md present ⇒ enforced)", () => {
    it("excludes a typeless issue", () => {
      const ready = [issue(1, { labels: ["ready-for-agent"] })];
      expect(
        countDispatchableIssues({ ready, openNumbers: [1], sandcastleMdExists: true }),
      ).toBe(0);
    });

    it("excludes a multi-type issue", () => {
      const ready = [issue(1, { labels: ["type:feature", "type:chore"] })];
      expect(
        countDispatchableIssues({ ready, openNumbers: [1], sandcastleMdExists: true }),
      ).toBe(0);
    });

    it("keeps an issue carrying exactly one type: label", () => {
      const ready = [issue(1, { labels: ["type:feature", "ready-for-agent"] })];
      expect(
        countDispatchableIssues({ ready, openNumbers: [1], sandcastleMdExists: true }),
      ).toBe(1);
    });

    it("is case-sensitive — `Type:` does not satisfy the rule", () => {
      const ready = [issue(1, { labels: ["Type:feature"] })];
      expect(
        countDispatchableIssues({ ready, openNumbers: [1], sandcastleMdExists: true }),
      ).toBe(0);
    });
  });

  describe("blocked-by rule", () => {
    it("excludes an issue blocked by an OPEN issue", () => {
      const ready = [issue(1, { body: "Blocked by: #2", labels: ["type:feature"] })];
      expect(
        countDispatchableIssues({ ready, openNumbers: [1, 2], sandcastleMdExists: true }),
      ).toBe(0);
    });

    it("keeps an issue blocked only by a CLOSED issue (blocker not in open set)", () => {
      const ready = [issue(1, { body: "Blocked by: #2", labels: ["type:feature"] })];
      // #2 is absent from openNumbers ⇒ closed ⇒ resolved.
      expect(
        countDispatchableIssues({ ready, openNumbers: [1], sandcastleMdExists: true }),
      ).toBe(1);
    });

    it("requires ALL stacked blockers to be closed", () => {
      const ready = [issue(1, { body: "Blocked by: #2, #3", labels: ["type:feature"] })];
      // #3 still open ⇒ excluded.
      expect(
        countDispatchableIssues({ ready, openNumbers: [1, 3], sandcastleMdExists: true }),
      ).toBe(0);
      // both #2 and #3 closed ⇒ kept.
      expect(
        countDispatchableIssues({ ready, openNumbers: [1], sandcastleMdExists: true }),
      ).toBe(1);
    });

    it("applies regardless of SANDCASTLE.md (rule is independent of the type: rule)", () => {
      const ready = [issue(1, { body: "Blocked by: #2", labels: [] })];
      expect(
        countDispatchableIssues({ ready, openNumbers: [1, 2], sandcastleMdExists: false }),
      ).toBe(0);
    });
  });

  it("counts an issue that is both typeless AND blocked exactly once as excluded", () => {
    const ready = [
      issue(1, { body: "Blocked by: #9", labels: [] }), // typeless + blocked
      issue(2, { body: "", labels: ["type:feature"] }), // dispatchable
    ];
    expect(
      countDispatchableIssues({ ready, openNumbers: [1, 2, 9], sandcastleMdExists: true }),
    ).toBe(1);
  });

  it("returns 0 for an empty ready set", () => {
    expect(
      countDispatchableIssues({ ready: [], openNumbers: [1, 2], sandcastleMdExists: true }),
    ).toBe(0);
  });
});
