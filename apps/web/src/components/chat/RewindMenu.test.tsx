/**
 * RewindMenu unit tests (Feature B).
 *
 * The web unit suite has no DOM (no jsdom / testing-library). RewindMenu is a
 * hookless component, so we render it at its public boundary — call it with
 * props, then verify behavior two ways:
 *   1. Structure via renderToStaticMarkup (which menu items exist / don't).
 *   2. "Click" by invoking the real onClick wired into the returned element
 *      tree, asserting the handler props fire. This is behavior-level: props
 *      in, rendered element out, click routes to the right handler.
 */
import { MessageId } from "@t3tools/contracts";
import { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { RewindMenu } from "./RewindMenu";
import { MenuItem } from "../ui/menu";

const MESSAGE_ID = MessageId.make("message-1");

// Recursively collect every element in a React tree whose `type` matches.
function collectByType(node: unknown, type: unknown, acc: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) collectByType(child, type, acc);
    return acc;
  }
  if (!node || typeof node !== "object") return acc;
  const element = node as ReactElement & { props?: { children?: unknown } };
  if (element.type === type) acc.push(element);
  if (element.props && element.props.children != null) {
    collectByType(element.props.children, type, acc);
  }
  return acc;
}

// The clickable trigger for the collapsed (no-checkpoint) case is the top-level
// element itself — a plain button whose onClick performs the rewind directly.
function clickTopLevel(element: ReactElement) {
  const onClick = (element.props as { onClick?: () => void }).onClick;
  if (typeof onClick !== "function") {
    throw new Error("expected the collapsed rewind trigger to have an onClick handler");
  }
  onClick();
}

describe("RewindMenu — no checkpoint collapses to a direct button (Feature B)", () => {
  it("renders a single direct button (no dropdown items) and fires onRestoreConversation once", () => {
    const onRestoreConversation = vi.fn();
    const onRestoreConversationAndFiles = vi.fn();

    const element = RewindMenu({
      messageId: MESSAGE_ID,
      hasCheckpoint: false,
      onRestoreConversation,
      onRestoreConversationAndFiles,
    }) as ReactElement;

    const markup = renderToStaticMarkup(element);
    expect(markup).toContain('aria-label="Rewind to this prompt"');
    expect(markup).not.toContain("Restore conversation only");
    expect(markup).not.toContain("Also restore files");

    clickTopLevel(element);
    expect(onRestoreConversation).toHaveBeenCalledTimes(1);
    expect(onRestoreConversation).toHaveBeenCalledWith(MESSAGE_ID);
    expect(onRestoreConversationAndFiles).not.toHaveBeenCalled();
  });

  it("uses a custom trigger directly and fires onRestoreConversation + onChosen", () => {
    const onRestoreConversation = vi.fn();
    const onRestoreConversationAndFiles = vi.fn();
    const onChosen = vi.fn();

    const element = RewindMenu({
      messageId: MESSAGE_ID,
      hasCheckpoint: false,
      onRestoreConversation,
      onRestoreConversationAndFiles,
      onChosen,
      trigger: (
        <button type="button" data-testid="picker-row">
          prompt preview
        </button>
      ),
    }) as ReactElement;

    const markup = renderToStaticMarkup(element);
    expect(markup).toContain("prompt preview");
    expect(markup).not.toContain("Also restore files");

    clickTopLevel(element);
    expect(onRestoreConversation).toHaveBeenCalledTimes(1);
    expect(onRestoreConversation).toHaveBeenCalledWith(MESSAGE_ID);
    expect(onChosen).toHaveBeenCalledTimes(1);
  });
});

describe("RewindMenu — checkpoint keeps the two-item dropdown", () => {
  it("renders both menu items, each routing to its own handler", () => {
    const onRestoreConversation = vi.fn();
    const onRestoreConversationAndFiles = vi.fn();
    const onChosen = vi.fn();

    const element = RewindMenu({
      messageId: MESSAGE_ID,
      hasCheckpoint: true,
      onRestoreConversation,
      onRestoreConversationAndFiles,
      onChosen,
    }) as ReactElement;

    // The popup contents live in a base-ui Menu that only renders into the DOM
    // once opened, so assert on the element tree (where both items always exist)
    // rather than closed-menu SSR markup.
    const items = collectByType(element, MenuItem);
    expect(items).toHaveLength(2);
    expect(JSON.stringify((items[0]!.props as { children?: unknown }).children)).toContain(
      "Restore conversation only",
    );
    expect(JSON.stringify((items[1]!.props as { children?: unknown }).children)).toContain(
      "Also restore files",
    );

    (items[0]!.props as { onClick: () => void }).onClick();
    expect(onRestoreConversation).toHaveBeenCalledTimes(1);
    expect(onRestoreConversation).toHaveBeenCalledWith(MESSAGE_ID);
    expect(onRestoreConversationAndFiles).not.toHaveBeenCalled();

    (items[1]!.props as { onClick: () => void }).onClick();
    expect(onRestoreConversationAndFiles).toHaveBeenCalledTimes(1);
    expect(onRestoreConversationAndFiles).toHaveBeenCalledWith(MESSAGE_ID);

    expect(onChosen).toHaveBeenCalledTimes(2);
  });
});
