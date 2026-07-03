/**
 * Pure helpers for the "Add to input" selection-quote toolbar. Kept free of
 * React/DOM wiring so they can be unit-tested in the node-based `unit` project.
 */

/**
 * Append quoted transcript text to the current composer draft. Never clobbers
 * existing text: when the draft is non-empty the quote goes on a new line after
 * it. Returns the new text and the cursor offset (end of text).
 */
export function appendQuoteToDraft(
  current: string,
  quoted: string,
): { text: string; cursor: number } {
  const trimmedQuote = quoted.trim();
  if (trimmedQuote.length === 0) return { text: current, cursor: current.length };
  const base = current.replace(/\s+$/u, ""); // drop trailing whitespace on existing draft
  const text = base.length === 0 ? trimmedQuote : `${base}\n${trimmedQuote}`;
  return { text, cursor: text.length };
}

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}
export interface Size {
  width: number;
  height: number;
}
export interface Viewport {
  width: number;
  height: number;
}

function clamp(value: number, min: number, max: number): number {
  // Guard against inverted bounds (toolbar wider/taller than the viewport):
  // never return below `min`.
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

/**
 * Position for a selection toolbar pill: horizontally centered over the selection
 * rect, sitting `gap` px ABOVE it; flips BELOW when there's no room above; clamped
 * within the viewport with an `edge` margin. Coordinates are viewport-relative
 * (for position: fixed). Returns {top, left}.
 */
export function computeSelectionToolbarPosition(
  selection: Rect,
  toolbar: Size,
  viewport: Viewport,
  opts?: { gap?: number; edge?: number },
): { top: number; left: number } {
  const gap = opts?.gap ?? 8;
  const edge = opts?.edge ?? 8;

  const left = clamp(
    selection.left + selection.width / 2 - toolbar.width / 2,
    edge,
    viewport.width - toolbar.width - edge,
  );

  const above = selection.top - gap - toolbar.height;
  const rawTop =
    above < edge ? selection.top + selection.height + gap : above;
  const top = clamp(rawTop, edge, viewport.height - toolbar.height - edge);

  return { top, left };
}

/** True when the DOM node is inside the given boundary element (or is it). */
export function isNodeWithinBoundary(node: Node | null, boundary: HTMLElement | null): boolean {
  if (!node || !boundary) return false;
  return boundary.contains(node);
}
