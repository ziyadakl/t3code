import { describe, expect, it } from "vite-plus/test";

import { isFoldableProgressNote, PROGRESS_NOTE_MAX_CHARS } from "./progressNote.ts";

describe("isFoldableProgressNote", () => {
  it("folds a short single-line note", () => {
    expect(isFoldableProgressNote("Let me check X.")).toBe(true);
  });

  it("ignores surrounding whitespace and newlines", () => {
    expect(isFoldableProgressNote("\n  Let me check X.  \n")).toBe(true);
  });

  it("folds a note exactly at the limit", () => {
    expect(isFoldableProgressNote("a".repeat(PROGRESS_NOTE_MAX_CHARS))).toBe(true);
  });

  it("keeps a single line over the limit visible", () => {
    expect(isFoldableProgressNote("a".repeat(PROGRESS_NOTE_MAX_CHARS + 1))).toBe(false);
  });

  it("keeps multi-line text, lists and headings visible", () => {
    expect(isFoldableProgressNote("The goal: ship it.\nThe parts: 1. a 2. b")).toBe(false);
    expect(isFoldableProgressNote("- one\n- two")).toBe(false);
    expect(isFoldableProgressNote("## Plan\nDo it.")).toBe(false);
    expect(isFoldableProgressNote("Line one\r\nLine two")).toBe(false);
  });
});
