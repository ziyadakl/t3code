import "../../index.css";

import { useRef } from "react";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { SelectionQuoteToolbar } from "./SelectionQuoteToolbar";

/**
 * Harness: a transcript boundary containing selectable text plus an "outside"
 * paragraph that lives OUTSIDE the boundary (to prove those selections are
 * ignored). The toolbar renders inside the boundary, keyed to it via boundaryRef.
 */
function Harness({ onQuote }: { onQuote: (text: string) => void }) {
  const boundaryRef = useRef<HTMLDivElement | null>(null);
  return (
    <div>
      <div ref={boundaryRef} data-testid="boundary">
        <p data-testid="inside">Quote me from the transcript</p>
      </div>
      <p data-testid="outside">Do not quote this outside paragraph</p>
      <SelectionQuoteToolbar boundaryRef={boundaryRef} onQuote={onQuote} />
    </div>
  );
}

async function selectText(el: Element): Promise<string> {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  return el.textContent ?? "";
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
});

describe("SelectionQuoteToolbar", () => {
  it("appears over a transcript selection and quotes the text on click", async () => {
    const onQuote = vi.fn();
    await render(<Harness onQuote={onQuote} />);

    const inside = await page.getByTestId("inside").element();
    const text = await selectText(inside);
    const pill = page.getByText("Add to input");
    await expect.element(pill).toBeVisible();

    await pill.click();
    expect(onQuote).toHaveBeenCalledWith(text.trim());
    // Pill dismisses after clicking.
    expect(page.getByText("Add to input").query()).toBeNull();
  });

  it("does not appear for selections outside the transcript boundary", async () => {
    const onQuote = vi.fn();
    await render(<Harness onQuote={onQuote} />);

    const outside = await page.getByTestId("outside").element();
    await selectText(outside);
    // Give the mouseup handler a tick to run.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(page.getByText("Add to input").query()).toBeNull();
    expect(onQuote).not.toHaveBeenCalled();
  });
});
