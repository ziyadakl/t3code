import { describe, expect, it } from "vite-plus/test";
import {
  computeSelectionToolbarPosition,
  insertQuoteAtCursor,
  isNodeWithinBoundary,
} from "./selectionQuote.logic";

describe("insertQuoteAtCursor", () => {
  it("appends a space + quote when the caret is at the end of a non-empty draft", () => {
    expect(insertQuoteAtCursor("foo", 3, "bar")).toEqual({
      text: "foo bar",
      cursor: 7,
    });
  });

  it("adds a trailing space (no leading space) when the caret is at the start", () => {
    expect(insertQuoteAtCursor("foo", 0, "bar")).toEqual({
      text: "bar foo",
      cursor: 3,
    });
  });

  it("does not add a leading space right after a newline", () => {
    expect(insertQuoteAtCursor("a\n", 2, "b")).toEqual({
      text: "a\nb",
      cursor: 3,
    });
  });

  it("adds leading + trailing spaces in the middle between two words", () => {
    expect(insertQuoteAtCursor("foobaz", 3, "X")).toEqual({
      text: "foo X baz",
      cursor: 5,
    });
  });

  it("does not double a leading space when the caret already follows a space", () => {
    expect(insertQuoteAtCursor("foo ", 4, "bar")).toEqual({
      text: "foo bar",
      cursor: 7,
    });
  });

  it("returns just the quote when the draft is empty", () => {
    expect(insertQuoteAtCursor("", 0, "bar")).toEqual({
      text: "bar",
      cursor: 3,
    });
  });

  it("trims whitespace surrounding the quote", () => {
    expect(insertQuoteAtCursor("foo", 3, "  spaced quote \n")).toEqual({
      text: "foo spaced quote",
      cursor: "foo spaced quote".length,
    });
  });

  it("is a no-op (clamped cursor) for a whitespace-only quote", () => {
    expect(insertQuoteAtCursor("keep me", 3, "   \n\t ")).toEqual({
      text: "keep me",
      cursor: 3,
    });
  });

  it("clamps a negative cursor to 0", () => {
    expect(insertQuoteAtCursor("foo", -5, "bar")).toEqual({
      text: "bar foo",
      cursor: 3,
    });
  });

  it("clamps an out-of-range cursor to the draft length", () => {
    expect(insertQuoteAtCursor("foo", 99, "bar")).toEqual({
      text: "foo bar",
      cursor: 7,
    });
  });
});

describe("computeSelectionToolbarPosition", () => {
  const viewport = { width: 1000, height: 800 };
  const toolbar = { width: 120, height: 28 };

  it("centers horizontally over the selection", () => {
    const { left } = computeSelectionToolbarPosition(
      { top: 400, left: 400, width: 200, height: 20 },
      toolbar,
      viewport,
    );
    // selection center = 500, toolbar left = 500 - 60 = 440
    expect(left).toBe(440);
  });

  it("sits the default gap above the selection when there is room", () => {
    const { top } = computeSelectionToolbarPosition(
      { top: 400, left: 400, width: 200, height: 20 },
      toolbar,
      viewport,
    );
    // 400 - 8 - 28 = 364
    expect(top).toBe(364);
  });

  it("clamps at the left edge when the selection hugs x=0", () => {
    const { left } = computeSelectionToolbarPosition(
      { top: 400, left: 0, width: 10, height: 20 },
      toolbar,
      viewport,
      { edge: 8 },
    );
    expect(left).toBe(8);
  });

  it("clamps at the right edge when the selection hugs the viewport width", () => {
    const { left } = computeSelectionToolbarPosition(
      { top: 400, left: 980, width: 20, height: 20 },
      toolbar,
      viewport,
      { edge: 8 },
    );
    // max left = 1000 - 120 - 8 = 872
    expect(left).toBe(872);
  });

  it("flips below the selection when there is no room above", () => {
    const { top } = computeSelectionToolbarPosition(
      { top: 4, left: 400, width: 100, height: 20 },
      toolbar,
      viewport,
      { gap: 8, edge: 8 },
    );
    // above would be 4 - 8 - 28 = -32 (< edge) → flip below: 4 + 20 + 8 = 32
    expect(top).toBe(32);
  });

  it("clamps top within the viewport bottom edge", () => {
    const { top } = computeSelectionToolbarPosition(
      { top: 4, left: 400, width: 100, height: 900 },
      { width: 120, height: 28 },
      { width: 1000, height: 200 },
      { gap: 8, edge: 8 },
    );
    // flip-below would be far past the bottom → clamp to 200 - 28 - 8 = 164
    expect(top).toBe(164);
  });
});

describe("isNodeWithinBoundary", () => {
  // The unit project runs in node (no real DOM), so exercise the null guards
  // and the delegation to `contains` with lightweight fakes.
  const node = {} as unknown as Node;

  it("returns false when the boundary is null", () => {
    expect(isNodeWithinBoundary(node, null)).toBe(false);
  });

  it("returns false when the node is null", () => {
    const boundary = { contains: () => true } as unknown as HTMLElement;
    expect(isNodeWithinBoundary(null, boundary)).toBe(false);
  });

  it("returns true when the boundary contains the node", () => {
    const boundary = { contains: (n: Node | null) => n === node } as unknown as HTMLElement;
    expect(isNodeWithinBoundary(node, boundary)).toBe(true);
  });

  it("returns false when the boundary does not contain the node", () => {
    const boundary = { contains: () => false } as unknown as HTMLElement;
    expect(isNodeWithinBoundary(node, boundary)).toBe(false);
  });
});
