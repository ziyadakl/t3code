import { describe, expect, it } from "vite-plus/test";
import {
  appendQuoteToDraft,
  computeSelectionToolbarPosition,
  isNodeWithinBoundary,
} from "./selectionQuote.logic";

describe("appendQuoteToDraft", () => {
  it("returns just the quote when the current draft is empty", () => {
    expect(appendQuoteToDraft("", "hello world")).toEqual({
      text: "hello world",
      cursor: "hello world".length,
    });
  });

  it("appends after existing text on a new line", () => {
    const result = appendQuoteToDraft("first line", "quoted");
    expect(result.text).toBe("first line\nquoted");
    expect(result.cursor).toBe("first line\nquoted".length);
  });

  it("trims trailing whitespace/newlines on the existing draft before joining", () => {
    const result = appendQuoteToDraft("draft   \n\n", "quoted");
    expect(result.text).toBe("draft\nquoted");
    expect(result.cursor).toBe("draft\nquoted".length);
  });

  it("trims whitespace surrounding the quote", () => {
    const result = appendQuoteToDraft("", "   spaced quote  \n");
    expect(result.text).toBe("spaced quote");
    expect(result.cursor).toBe("spaced quote".length);
  });

  it("returns the current draft unchanged (cursor at end) for an empty quote", () => {
    expect(appendQuoteToDraft("keep me", "")).toEqual({
      text: "keep me",
      cursor: "keep me".length,
    });
  });

  it("returns the current draft unchanged for a whitespace-only quote", () => {
    expect(appendQuoteToDraft("keep me", "   \n\t ")).toEqual({
      text: "keep me",
      cursor: "keep me".length,
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
