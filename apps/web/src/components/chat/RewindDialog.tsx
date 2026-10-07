import { THREAD_REWIND_CHOICES, type ThreadRewindChoice } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";

/** Claude Code's `/rewind` menu labels. */
export const REWIND_CHOICE_LABELS: Record<ThreadRewindChoice, string> = {
  "code-and-conversation": "Restore code and conversation",
  conversation: "Restore conversation",
  code: "Restore code",
  "summarize-from": "Summarize from here",
  "summarize-up-to": "Summarize up to here",
};

const isSummarizeChoice = (choice: ThreadRewindChoice) =>
  choice === "summarize-from" || choice === "summarize-up-to";

/**
 * The rewind menu for one sent user message. It lists `choices` in Claude
 * Code's order, then "Never mind". A summarize choice first asks for optional
 * instructions. Every row is a full-size button, so it works by touch.
 */
export function RewindDialog(props: {
  open: boolean;
  /** The choices the server can carry out for this message. */
  choices: ReadonlyArray<ThreadRewindChoice>;
  /** What a code restore would change, or why there is none. */
  note?: string | null;
  onChoose: (choice: ThreadRewindChoice, instructions: string | undefined) => void;
  /** "Never mind", Escape or a click outside: closes with no change. */
  onCancel: () => void;
}) {
  const [summarizeChoice, setSummarizeChoice] = useState<ThreadRewindChoice | null>(null);
  const [instructions, setInstructions] = useState("");
  const close = () => {
    setSummarizeChoice(null);
    setInstructions("");
    props.onCancel();
  };
  const choose = (choice: ThreadRewindChoice, text: string | undefined) => {
    setSummarizeChoice(null);
    setInstructions("");
    props.onChoose(choice, text);
  };
  const offered = THREAD_REWIND_CHOICES.filter((choice) => props.choices.includes(choice));

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Rewind</DialogTitle>
          <DialogDescription>
            {summarizeChoice === null
              ? "Go back to before this message."
              : `${REWIND_CHOICE_LABELS[summarizeChoice]}. Your files stay as they are.`}
          </DialogDescription>
          {summarizeChoice === null && props.note ? (
            <p className="text-muted-foreground text-sm">{props.note}</p>
          ) : null}
        </DialogHeader>
        <DialogPanel>
          {summarizeChoice === null ? (
            <div className="grid gap-2">
              {offered.map((choice) => (
                <Button
                  key={choice}
                  variant="outline"
                  size="lg"
                  onClick={() =>
                    isSummarizeChoice(choice)
                      ? setSummarizeChoice(choice)
                      : choose(choice, undefined)
                  }
                >
                  {REWIND_CHOICE_LABELS[choice]}
                </Button>
              ))}
              <Button variant="ghost" size="lg" onClick={close}>
                Never mind
              </Button>
            </div>
          ) : (
            <Textarea
              autoFocus
              aria-label="Summary instructions"
              placeholder="Add context (optional)"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
          )}
        </DialogPanel>
        {summarizeChoice === null ? null : (
          <DialogFooter>
            <Button variant="outline" onClick={() => setSummarizeChoice(null)}>
              Back
            </Button>
            <Button
              onClick={() => {
                const text = instructions.trim();
                choose(summarizeChoice, text.length === 0 ? undefined : text);
              }}
            >
              Summarize
            </Button>
          </DialogFooter>
        )}
      </DialogPopup>
    </Dialog>
  );
}
