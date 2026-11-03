// Fork (Claude rewind): Upstream's `rewindToMessage` (chatViewSend.ts) is checkpoint-only; this
// one also carries a Claude Code style rewind choice, and waits for the recorded outcome.
import {
  CommandId,
  type EnvironmentId,
  type MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ScopedThreadRef,
  type ThreadId,
  type ThreadRewindChoice,
  threadRewindRestoresPrompt,
} from "@t3tools/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { randomUUID } from "~/lib/utils";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftId,
  useComposerDraftStore,
} from "../../composerDraftStore";
import type { findRevertCheckpoint } from "../../session-logic";
import { readPreparedConnection } from "../../state/session";
import type { ChatMessage } from "../../types";
import { prepareRevertedMessageAttachments } from "../ChatView.logic";
import { recallableComposerPrompt } from "./composerPromptHistory";
import { waitForRewindOutcome } from "./messageRewind.logic";

/** A git checkpoint rollback, or a Claude Code style rewind choice. */
export type RevertAction =
  | { readonly type: "checkpoint"; readonly restoreFiles: boolean }
  | {
      readonly type: "rewind";
      readonly choice: ThreadRewindChoice;
      readonly instructions?: string;
    };

/**
 * Rewinds the thread to before `message` with `action`, and puts the message's
 * prompt and attachments back in the composer when the action restores the
 * conversation. `notice` is the provider's note for the user, if any.
 */
export async function rewindToMessageWithChoice(input: {
  readonly message: ChatMessage;
  readonly environmentId: EnvironmentId;
  readonly routeThreadRef: ScopedThreadRef;
  readonly threadId: ThreadId;
  readonly turnCount: number;
  readonly action: RevertAction;
  readonly checkpoint: ReturnType<typeof findRevertCheckpoint>;
  readonly draftTarget: ScopedThreadRef | DraftId;
  readonly composerHasPendingAttachments: boolean;
  readonly createAssetUrl: Parameters<
    typeof prepareRevertedMessageAttachments
  >[0]["createAssetUrl"];
  readonly revertThreadCheckpoint: (value: {
    environmentId: EnvironmentId;
    input: {
      commandId: CommandId;
      threadId: ThreadId;
      turnCount: number;
      restoreFiles: boolean;
      checkpointId?: string;
      scopeId?: string;
    };
  }) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly rewindThread: (value: {
    environmentId: EnvironmentId;
    input: {
      commandId: CommandId;
      threadId: ThreadId;
      messageId: MessageId;
      choice: ThreadRewindChoice;
      instructions?: string;
    };
  }) => Promise<AtomCommandResult<unknown, unknown>>;
}): Promise<
  | { readonly error: string; readonly prompt?: never; readonly notice?: never }
  | { readonly error: null; readonly prompt: string | null; readonly notice: string | null }
> {
  const { message, environmentId, draftTarget, action } = input;
  const restoresPrompt = action.type === "checkpoint" || threadRewindRestoresPrompt(action.choice);
  try {
    if (input.composerHasPendingAttachments) {
      throw new Error("Wait for attachments to finish preparing before rewinding.");
    }
    const connection = readPreparedConnection(environmentId);
    if (!connection) throw new Error("The environment is not connected.");
    const files = restoresPrompt
      ? await prepareRevertedMessageAttachments({
          message,
          environmentId,
          httpBaseUrl: connection.httpBaseUrl,
          createAssetUrl: input.createAssetUrl,
        })
      : [];
    const store = useComposerDraftStore.getState();
    const draft = store.getComposerDraft(draftTarget);
    if (
      (draft?.images.length ?? 0) + (draft?.files.length ?? 0) + files.length >
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    ) {
      throw new Error("Make room for this message's attachments in the composer before rewinding.");
    }
    const commandId = CommandId.make(randomUUID());
    const notice = await waitForRewindOutcome(
      input.routeThreadRef,
      message.id,
      commandId,
      async () => {
        const result =
          action.type === "checkpoint"
            ? await input.revertThreadCheckpoint({
                environmentId,
                input: {
                  commandId,
                  threadId: input.threadId,
                  turnCount: input.turnCount,
                  restoreFiles: action.restoreFiles,
                  ...(input.checkpoint === undefined
                    ? {}
                    : { checkpointId: input.checkpoint.id, scopeId: input.checkpoint.scopeId }),
                },
              })
            : await input.rewindThread({
                environmentId,
                input: {
                  commandId,
                  threadId: input.threadId,
                  messageId: message.id,
                  choice: action.choice,
                  ...(action.instructions === undefined
                    ? {}
                    : { instructions: action.instructions }),
                },
              });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      },
      { awaitsRecordedOutcome: action.type === "rewind", turnCount: input.turnCount },
    );
    if (!restoresPrompt) return { error: null, prompt: null, notice };
    const currentPrompt = store.getComposerDraft(draftTarget)?.prompt ?? "";
    const restoredPrompt = recallableComposerPrompt(message.text);
    const nextPrompt =
      restoredPrompt.length === 0
        ? currentPrompt
        : currentPrompt.length > 0
          ? `${currentPrompt}\n\n${restoredPrompt}`
          : restoredPrompt;
    store.setPrompt(draftTarget, nextPrompt);
    const images: ComposerImageAttachment[] = [];
    const restoredFiles: ComposerFileAttachment[] = [];
    files.forEach((file, index) => {
      const attachment = {
        id: randomUUID(),
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        file,
      };
      if (message.attachments?.[index]?.type === "image") {
        images.push({ ...attachment, type: "image", previewUrl: URL.createObjectURL(file) });
      } else {
        restoredFiles.push({ ...attachment, type: "file" });
      }
    });
    store.addImages(draftTarget, images, { allowDuplicates: true });
    store.addFiles(draftTarget, restoredFiles, { allowDuplicates: true });
    return { error: null, prompt: nextPrompt, notice };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to revert thread state." };
  }
}
