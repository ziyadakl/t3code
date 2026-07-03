import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { TextQuoteIcon } from "lucide-react";
import {
  computeSelectionToolbarPosition,
  isNodeWithinBoundary,
  type Rect,
} from "./selectionQuote.logic";

interface SelectionQuoteToolbarProps {
  /** The transcript element; only selections whose anchor+focus live inside it
   *  surface the pill (excludes composer/sidebar selections). */
  boundaryRef: RefObject<HTMLElement | null>;
  /** Called with the trimmed selected text when the user clicks "Add to input". */
  onQuote: (text: string) => void;
}

// Fallback width used before the pill has been measured (first paint).
const ESTIMATED_TOOLBAR_WIDTH = 120;
const ESTIMATED_TOOLBAR_HEIGHT = 28;

/**
 * A floating "Add to input" pill that appears just above a text selection inside
 * the chat transcript. Clicking it hands the selected text to {@link onQuote}
 * (which appends it to the composer draft) and dismisses the pill.
 */
export function SelectionQuoteToolbar({ boundaryRef, onQuote }: SelectionQuoteToolbarProps) {
  const [selectionText, setSelectionText] = useState("");
  const [anchorRect, setAnchorRect] = useState<Rect | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [toolbarSize, setToolbarSize] = useState({
    width: ESTIMATED_TOOLBAR_WIDTH,
    height: ESTIMATED_TOOLBAR_HEIGHT,
  });

  const hide = useCallback(() => {
    setAnchorRect(null);
    setSelectionText("");
  }, []);

  // Recompute from the live selection: show only for a non-empty selection whose
  // anchor AND focus are both inside the transcript boundary.
  const syncFromSelection = useCallback(() => {
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      hide();
      return;
    }
    const text = sel.toString().trim();
    if (text.length === 0) {
      hide();
      return;
    }
    const boundary = boundaryRef.current;
    if (
      !isNodeWithinBoundary(sel.anchorNode, boundary) ||
      !isNodeWithinBoundary(sel.focusNode, boundary)
    ) {
      hide();
      return;
    }
    const domRect = sel.getRangeAt(0).getBoundingClientRect();
    setSelectionText(text);
    setAnchorRect({
      top: domRect.top,
      left: domRect.left,
      width: domRect.width,
      height: domRect.height,
    });
  }, [boundaryRef, hide]);

  useEffect(() => {
    // mouseup: (re)evaluate the selection after the user finishes dragging.
    const onMouseUp = () => syncFromSelection();
    // selectionchange: hide as soon as the selection collapses/empties.
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0 || sel.toString().trim().length === 0) {
        hide();
      }
    };
    // A scroll (capture, so it catches the transcript's inner scroller), resize,
    // or Escape all make the stored rect stale → dismiss.
    const onScroll = () => hide();
    const onResize = () => hide();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };

    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [syncFromSelection, hide]);

  // Measure the pill once it is in the DOM so the position is exact.
  useLayoutEffect(() => {
    if (!anchorRect) return;
    const el = buttonRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (
      rect.width > 0 &&
      (Math.abs(rect.width - toolbarSize.width) > 0.5 ||
        Math.abs(rect.height - toolbarSize.height) > 0.5)
    ) {
      setToolbarSize({ width: rect.width, height: rect.height });
    }
  }, [anchorRect, toolbarSize.width, toolbarSize.height]);

  const handleClick = useCallback(() => {
    onQuote(selectionText);
    hide();
    window.getSelection()?.removeAllRanges();
  }, [onQuote, selectionText, hide]);

  if (!anchorRect) return null;

  const { top, left } = computeSelectionToolbarPosition(anchorRect, toolbarSize, {
    width: window.innerWidth,
    height: window.innerHeight,
  });

  return (
    <button
      ref={buttonRef}
      type="button"
      // Prevent the mousedown from collapsing the current selection before the
      // click handler runs.
      onMouseDown={(event) => event.preventDefault()}
      onClick={handleClick}
      style={{ position: "fixed", top, left }}
      className="pointer-events-auto z-50 flex items-center gap-1.5 rounded-full border border-border/60 bg-card px-2.5 py-1 text-foreground text-xs shadow-md transition-colors hover:cursor-pointer hover:border-border"
    >
      <TextQuoteIcon className="size-3.5" />
      Add to input
    </button>
  );
}
