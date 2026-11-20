import { getProviderSkillsForSlashMenu } from "@t3tools/client-runtime/providerSkills";
import {
  use,
  useId,
  useLayoutEffect,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { useTheme } from "~/hooks/useTheme";

import {
  detectComposerTrigger,
  extendReplacementRangeForTrailingSpace,
  replaceTextRange,
} from "../../composer-logic";
import { ComposerContextActionsContext } from "../composerContextActions";
import {
  ComposerCommandMenu,
  composerSuggestionOptionId,
  type ComposerCommandItem,
} from "./ComposerCommandMenu";
import { searchSlashCommandItems } from "./composerSlashCommandSearch";

type MenuPlacement = { side: "above" | "below"; maxHeight: number };

const VIEWPORT_MARGIN_PX = 8;

/**
 * The composer's skill list for a quote's note: `/` at a word start lists the selected provider's
 * skills, and a pick types `/name `. Keys go to the list while it shows; Escape closes only it.
 */
export function useNoteSkillMenu({
  text,
  textareaRef,
  onTextChange,
}: {
  text: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onTextChange: (text: string) => void;
}) {
  const { noteSkills } = use(ComposerContextActionsContext);
  const { resolvedTheme } = useTheme();
  const listId = useId();
  const [cursor, setCursor] = useState<number | null>(null);
  const [dismissedStart, setDismissedStart] = useState<number | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const trigger = noteSkills && cursor !== null ? detectComposerTrigger(text, cursor) : null;
  const slashTrigger =
    trigger?.kind === "slash-command" && trigger.rangeStart !== dismissedStart ? trigger : null;
  const items: ComposerCommandItem[] =
    noteSkills && slashTrigger
      ? searchSlashCommandItems(
          getProviderSkillsForSlashMenu(noteSkills.skills, true).map((skill) => ({
            id: `skill:${noteSkills.provider}:${skill.name}`,
            type: "skill" as const,
            provider: noteSkills.provider,
            skill,
            label: `/${skill.name}`,
            description:
              skill.shortDescription ??
              skill.description ??
              (skill.scope ? `${skill.scope} skill` : "Run provider skill"),
          })),
          slashTrigger.query,
        )
      : [];
  const open = slashTrigger !== null && items.length > 0;
  const activeItem = items.find((item) => item.id === highlightedId) ?? items[0] ?? null;

  const syncCursor = (input: HTMLTextAreaElement) => {
    setCursor(input.selectionStart === input.selectionEnd ? input.selectionStart : null);
    if (detectComposerTrigger(input.value, input.selectionStart)?.kind !== "slash-command") {
      setDismissedStart(null);
    }
  };

  const select = (item: ComposerCommandItem) => {
    const input = textareaRef.current;
    if (!slashTrigger || item.type !== "skill" || !input) return;
    const replacement = `/${item.skill.name} `;
    const next = replaceTextRange(
      text,
      slashTrigger.rangeStart,
      extendReplacementRangeForTrailingSpace(text, slashTrigger.rangeEnd, replacement),
      replacement,
    );
    // Writing the DOM first keeps the caret where it lands once React re-renders the same value.
    input.value = next.text;
    input.setSelectionRange(next.cursor, next.cursor);
    setCursor(next.cursor);
    setHighlightedId(null);
    onTextChange(next.text);
  };

  /** Returns true when the list consumed the key. */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || !activeItem || event.nativeEvent.isComposing || event.keyCode === 229) {
      return false;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : -1;
      const index = items.indexOf(activeItem);
      setHighlightedId(items[(index + step + items.length) % items.length]!.id);
    } else if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      select(activeItem);
    } else if (event.key === "Escape") {
      setDismissedStart(slashTrigger.rangeStart);
    } else {
      return false;
    }
    event.preventDefault();
    return true;
  };

  return {
    onKeyDown,
    syncCursor,
    // A pick keeps focus (rows take mousedown), so a blur means the user left the note box.
    onBlur: () => setCursor(null),
    textareaProps: open
      ? {
          "aria-controls": listId,
          "aria-autocomplete": "list" as const,
          "aria-activedescendant": activeItem
            ? composerSuggestionOptionId(listId, activeItem.id)
            : undefined,
        }
      : {},
    menu: open ? (
      <NoteSkillMenuLayer anchorRef={textareaRef}>
        <ComposerCommandMenu
          listId={listId}
          items={items}
          resolvedTheme={resolvedTheme}
          isLoading={false}
          triggerKind="skill"
          detached
          activeItemId={activeItem?.id ?? null}
          onHighlightedItemChange={setHighlightedId}
          onSelect={select}
        />
      </NoteSkillMenuLayer>
    ) : null,
  };
}

/**
 * Hangs the list off the note's popup, inside it so a click is not an outside press, on the
 * side with more room so it stays on screen.
 */
function NoteSkillMenuLayer({
  anchorRef,
  children,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const [layer, setLayer] = useState<{ host: HTMLElement; placement: MenuPlacement } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the note popup's DOM rect to place the list, tracking window resize
  useLayoutEffect(() => {
    const host = anchorRef.current?.closest<HTMLElement>('[data-slot="popover-popup"]');
    if (!host) return;
    const update = () => {
      const rect = host.getBoundingClientRect();
      const above = rect.top - VIEWPORT_MARGIN_PX;
      const below = window.innerHeight - rect.bottom - VIEWPORT_MARGIN_PX;
      setLayer({
        host,
        placement:
          below >= above
            ? { side: "below", maxHeight: Math.max(96, below) }
            : { side: "above", maxHeight: Math.max(96, above) },
      });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [anchorRef]);

  if (!layer) return null;
  return createPortal(
    <div
      data-note-skill-menu="true"
      className="absolute inset-x-0 z-10 flex flex-col"
      style={{
        maxHeight: layer.placement.maxHeight,
        ...(layer.placement.side === "below"
          ? { top: `calc(100% + ${VIEWPORT_MARGIN_PX / 2}px)` }
          : { bottom: `calc(100% + ${VIEWPORT_MARGIN_PX / 2}px)` }),
      }}
    >
      {children}
    </div>,
    layer.host,
  );
}
