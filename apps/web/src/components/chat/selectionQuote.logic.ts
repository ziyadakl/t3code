/**
 * Pure helpers for the "Add to input" selection-quote toolbar. Kept free of
 * React/DOM wiring so they can be unit-tested in the node-based `unit` project.
 */

/**
 * Insert quoted transcript text into the composer draft at the given caret
 * offset (a string index into `current`). Adds a single space before the quote
 * when the char just before the caret is non-whitespace, and a single space
 * after when the char just after is non-whitespace — so the quote never jams
 * against adjacent words, but stays flush at line starts / after a newline.
 * Returns the new text and the caret offset positioned right AFTER the inserted
 * quote (before any trailing space) so typing continues naturally. An
 * empty/whitespace quote is a no-op (returns current text + the same cursor).
 */
export function insertQuoteAtCursor(
  current: string,
  cursor: number,
  quoted: string,
): { text: string; cursor: number } {
  const q = quoted.trim();
  const caret = Math.max(0, Math.min(cursor, current.length)); // clamp
  if (q.length === 0) return { text: current, cursor: caret };
  const before = current.slice(0, caret);
  const after = current.slice(caret);
  const lead = before.length > 0 && !/\s$/u.test(before) ? " " : "";
  const trail = after.length > 0 && !/^\s/u.test(after) ? " " : "";
  const text = `${before}${lead}${q}${trail}${after}`;
  const nextCursor = before.length + lead.length + q.length;
  return { text, cursor: nextCursor };
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
