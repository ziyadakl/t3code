import type { EnvironmentThreadShell, ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type { ComposerThreadTarget } from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import type { SessionPhase } from "../../types";
import { useRef, useState, useEffect, type ComponentProps } from "react";
import { toastManager } from "../ui/toast";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useThreadRewindPreview } from "../../state/queries";
import type { RewindPicker } from "./RewindPicker";
import { keepRewindPickerOpen, rewindPickerItems } from "./RewindPicker.logic";
import { useEscapeToStopAndRewind } from "./escapeRewind";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type MessageId,
  type ScopedThreadRef,
  type ThreadId,
  type ThreadRewindChoice,
  type RunId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { readLocalApi } from "../../localApi";
import {
  deriveMessageRewindTargets,
  findRevertCheckpoint,
  revertTouchesFiles,
} from "../../session-logic";
import { type ChatMessage } from "../../types";
import { newThreadId } from "~/lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useComposerDraftStore } from "../../composerDraftStore";
import { threadEnvironment } from "../../state/threads";
import { waitForThreadShell } from "../../state/entities";
import { openRevertConfirm } from "./ChatOverlayHosts";
import { assetEnvironment } from "../../state/assets";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { rewindToMessage, type RevertAction } from "./chatViewSend";
import {
  decideMessageRewindStart,
  deriveMessageRewindMenu,
  loadThreadRewindPreview,
  makeThreadErrorSetter,
  messageRewindBlockedReason,
  planMessageRewind,
  waitForThreadToStop,
} from "../ChatView.logic";
interface TimelineRewindInput {
  readonly environmentId: EnvironmentId;
  readonly routeThreadRef: ScopedThreadRef;
  readonly routeThreadKey: string;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly serverProjection: ThreadStructure | null;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly timelineMessages: ReadonlyArray<ChatMessage>;
  readonly paintOnlyDisplayedTimeline: boolean;
  readonly phase: SessionPhase;
  readonly isConnecting: boolean;
  readonly isSendBusy: boolean;
  readonly isRevertingCheckpoint: boolean;
  readonly supportsConversationRollback: boolean;
  readonly activeEnvironmentUnavailable: boolean;
  readonly activeEnvironmentUnavailableLabel: string | null;
  readonly promptRef: { current: string };
  readonly composerRef: ComposerHandleRef;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
  // Fork (Claude rewind): the rewind menu, the Esc picker, and stopping a running turn first.
  readonly supportsMessageRewind: boolean;
  readonly canInterruptRunningThread: boolean;
  readonly isWorking: boolean;
  readonly isServerThread: boolean;
  readonly timelineEntries: Parameters<typeof deriveMessageRewindTargets>[0]["timelineEntries"];
  readonly turnDiffSummaries: Parameters<typeof revertTouchesFiles>[0];
  readonly onInterrupt: () => Promise<void> | void;
}

/**
 * Going back in a thread's timeline: reverting to an earlier turn (restoring that message into
 * the composer), rolling back a provider checkpoint, and forking a new thread from a run.
 */
export function useTimelineRewind(input: TimelineRewindInput) {
  const {
    environmentId,
    routeThreadRef,
    routeThreadKey,
    currentRouteThreadKeyRef,
    serverProjection,
    activeThread,
    timelineMessages,
    paintOnlyDisplayedTimeline,
    phase,
    isConnecting,
    isSendBusy,
    isRevertingCheckpoint,
    supportsConversationRollback,
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableLabel,
    promptRef,
    composerRef,
    composerDraftTarget,
    setThreadError,
    supportsMessageRewind,
    canInterruptRunningThread,
    isWorking,
    isServerThread,
    timelineEntries,
    turnDiffSummaries,
    onInterrupt,
  } = input;
  const navigate = useNavigate();
  const createAttachmentAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });

  const revertThreadCheckpoint = useOrchestrationCommand(threadEnvironment.revertCheckpoint, {
    reportFailure: false,
  });
  const interruptThreadTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const rewindThread = useAtomCommand(threadEnvironment.rewind, { reportFailure: false });
  const forkThreadFromRun = useAtomCommand(threadEnvironment.forkFromRun, {
    reportFailure: false,
  });

  const [pendingRewind, setPendingRewind] = useState<{
    readonly turnCount: number;
    readonly messageId: MessageId;
    readonly routeThreadKey: string;
  } | null>(null);
  if (pendingRewind && pendingRewind.routeThreadKey !== routeThreadKey) {
    setPendingRewind(null);
  }
  // While a Claude message's rewind menu is open, Claude dry-runs a code
  // restore; the code choices show only when it would change files.
  const rewindPreview = useThreadRewindPreview(
    supportsMessageRewind && pendingRewind !== null && activeThread
      ? { environmentId, threadId: activeThread.id, messageId: pendingRewind.messageId }
      : null,
  );
  const messageRewindMenu = deriveMessageRewindMenu({
    preview: rewindPreview.data,
    error: rewindPreview.error,
  });

  // Shows "Rewinding conversation" on this thread while `run` works.
  const withRewindProgress = async (run: () => Promise<void>) => {
    useComposerDraftStore.setState((store) => ({
      rewindingThreadKeys: new Set(store.rewindingThreadKeys).add(routeThreadKey),
    }));
    // `.finally` rather than try/finally: React Compiler cannot compile a
    // `finally` without a `catch`.
    await run().finally(() => {
      useComposerDraftStore.setState((store) => {
        const remaining = new Set(store.rewindingThreadKeys);
        remaining.delete(routeThreadKey);
        return { rewindingThreadKeys: remaining };
      });
    });
  };
  /**
   * Rewinds to before `messageId` with `chosenAction`; without one, rewinds
   * the conversation when no files could change, or opens the rewind menu.
   * Unguarded: callers make sure nothing runs and show the progress.
   */
  const performRewind = async (
    turnCount: number,
    messageId: MessageId,
    chosenAction?: RevertAction,
  ) => {
    const localApi = readLocalApi();
    if (
      !localApi ||
      !activeThread ||
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
    )
      return;
    const message = timelineMessages.find((message) => message.id === messageId);
    if (!message || message.role !== "user") return;
    if (!supportsConversationRollback && !supportsMessageRewind) {
      setThreadError(
        activeThread.id,
        "This provider does not support reverting conversation history. Start a new thread instead.",
      );
      return;
    }
    if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
      setThreadError(
        activeThread.id,
        `Reconnect ${activeEnvironmentUnavailableLabel} before reverting checkpoints.`,
      );
      return;
    }
    const rewindBlockedReason = supportsMessageRewind
      ? messageRewindBlockedReason(serverProjection?.runs ?? [])
      : null;
    if (rewindBlockedReason !== null) {
      setThreadError(activeThread.id, rewindBlockedReason);
      return;
    }
    // With no file changes since the revert point there is nothing to ask:
    // rewind the conversation and keep the workspace as it is.
    const action: RevertAction | undefined =
      chosenAction ??
      (supportsMessageRewind || revertTouchesFiles(turnDiffSummaries, turnCount)
        ? undefined
        : { type: "checkpoint", restoreFiles: false });
    if (action === undefined) {
      if (supportsMessageRewind) {
        setPendingRewind({ turnCount, messageId, routeThreadKey });
      } else {
        openRevertConfirm(routeThreadKey, { turnCount, messageId });
      }
      return;
    }

    setThreadError(activeThread.id, null);
    const rewind = await rewindToMessage({
      message,
      environmentId,
      routeThreadRef,
      threadId: activeThread.id,
      turnCount,
      action,
      // Keep the live checkpoint identity when command context refetches a bounded window.
      checkpoint: findRevertCheckpoint(serverProjection?.checkpoints ?? [], turnCount),
      draftTarget: composerDraftTarget,
      composerHasPendingAttachments: composerRef.current?.hasPendingAttachments() === true,
      createAssetUrl: createAttachmentAssetUrl,
      revertThreadCheckpoint,
      rewindThread,
    });
    if (rewind.error !== null) {
      setThreadError(activeThread.id, rewind.error);
      return;
    }
    if (rewind.notice !== null) {
      toastManager.add({ type: "warning", title: "Rewind finished", description: rewind.notice });
    }
    if (rewind.prompt !== null && currentRouteThreadKeyRef.current === routeThreadKey) {
      const nextPrompt = rewind.prompt;
      promptRef.current = nextPrompt;
      composerRef.current?.resetCursorState({ prompt: nextPrompt, cursor: nextPrompt.length });
      requestAnimationFrame(() => {
        if (currentRouteThreadKeyRef.current === routeThreadKey) composerRef.current?.focusAtEnd();
      });
    }
  };
  /** The rewind dialogs' entry: refused while a turn runs or a rewind is under way. */
  const onRevertToTurnCount = async (
    turnCount: number,
    messageId: MessageId,
    action?: RevertAction,
  ) => {
    if (!activeThread || isRevertingCheckpoint) return;
    if (phase === "running" || isSendBusy || isConnecting) {
      setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
      return;
    }
    await withRewindProgress(() => performRewind(turnCount, messageId, action));
  };
  const onConfirmRevert = (turnCount: number, messageId: MessageId, restoreFiles: boolean) => {
    void onRevertToTurnCount(turnCount, messageId, { type: "checkpoint", restoreFiles });
  };
  const onConfirmRevertStable = useStableCallback(onConfirmRevert);

  // The dry run a click fetched stays mounted while its rewind menu is open,
  // so the menu shows it without asking Claude again, and is released when
  // the menu closes.
  const heldRewindPreviewRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (pendingRewind !== null) return;
    heldRewindPreviewRef.current?.();
    heldRewindPreviewRef.current = null;
  }, [pendingRewind]);
  useEffect(() => {
    const held = heldRewindPreviewRef;
    return () => held.current?.();
  }, []);
  const messageRewindStartingRef = useRef(false);
  /**
   * The rewind arrow's one entry. Stops a running turn first, then rewinds
   * the conversation at once when no code choice could apply (the prompt
   * returns to the composer), or opens the rewind menu.
   */
  const requestMessageRewind = async (turnCount: number, messageId: MessageId) => {
    if (!activeThread || isRevertingCheckpoint || messageRewindStartingRef.current) return;
    const threadId = activeThread.id;
    let step = planMessageRewind({
      canInterrupt: canInterruptRunningThread,
      isWorking,
      supportsMessageRewind,
      afterStop: false,
      runs: serverProjection?.runs ?? [],
    });
    if (step.kind === "refuse") {
      setThreadError(threadId, step.reason);
      return;
    }
    const askInMenu = () => setPendingRewind({ turnCount, messageId, routeThreadKey });
    messageRewindStartingRef.current = true;
    await withRewindProgress(async () => {
      let heldPreview: (() => void) | null = null;
      // Promise `.catch`/`.finally` below, not try/catch/finally: React Compiler
      // cannot compile `finally`, nor a `throw` inside a `try`.
      const start = async () => {
        if (step.kind === "stop-first") {
          const result = await interruptThreadTurn({ environmentId, input: { threadId } });
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            throw squashAtomCommandFailure(result);
          }
          step = planMessageRewind({
            canInterrupt: false,
            isWorking: false,
            supportsMessageRewind,
            afterStop: true,
            runs: await waitForThreadToStop(routeThreadRef),
          });
        }
        switch (step.kind) {
          case "refuse":
            throw new Error(step.reason);
          case "ask":
            askInMenu();
            return;
          case "check-files": {
            const loaded = await loadThreadRewindPreview({
              environmentId,
              threadId,
              messageId,
            });
            heldPreview = loaded.release;
            if (decideMessageRewindStart(loaded).kind === "ask") {
              // Left this thread (or unmounted, which nulls the ref) during
              // the dry run: no menu opens, so `finally` releases it now.
              if (currentRouteThreadKeyRef.current !== routeThreadKey) return;
              heldRewindPreviewRef.current?.();
              heldRewindPreviewRef.current = heldPreview;
              heldPreview = null;
              askInMenu();
              return;
            }
            await performRewind(turnCount, messageId, {
              type: "rewind",
              choice: "conversation",
            });
            return;
          }
          default:
            await performRewind(turnCount, messageId);
        }
      };
      await start()
        .catch((error: unknown) => {
          setThreadError(
            threadId,
            error instanceof Error ? error.message : "Failed to start the rewind.",
          );
        })
        .finally(() => {
          heldPreview?.();
        });
    }).finally(() => {
      messageRewindStartingRef.current = false;
    });
  };
  const requestMessageRewindStable = useStableCallback(requestMessageRewind);

  const onRollbackCheckpoint = async (input: {
    readonly checkpointId: string;
    readonly scopeId: string;
  }) => {
    if (!activeThread || isRevertingCheckpoint) return;
    if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
      setThreadError(
        activeThread.id,
        `Reconnect ${activeEnvironmentUnavailableLabel} before reverting checkpoints.`,
      );
      return;
    }
    if (phase === "running" || isSendBusy || isConnecting) {
      setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
      return;
    }
    const localApi = readLocalApi();
    const confirmed =
      localApi == null
        ? window.confirm("Roll back this thread to the selected checkpoint?")
        : await localApi.dialogs.confirm(
            "Roll back this thread to the selected checkpoint?\nThis action cannot be undone.",
          );
    if (!confirmed) return;

    useComposerDraftStore.setState((store) => ({
      rewindingThreadKeys: new Set(store.rewindingThreadKeys).add(routeThreadKey),
    }));
    setThreadError(activeThread.id, null);
    const result = await revertThreadCheckpoint({
      environmentId,
      input: {
        threadId: activeThread.id,
        checkpointId: input.checkpointId,
        scopeId: input.scopeId,
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThread.id,
        error instanceof Error ? error.message : "Failed to revert thread state.",
      );
    }
    useComposerDraftStore.setState((store) => {
      const remaining = new Set(store.rewindingThreadKeys);
      remaining.delete(routeThreadKey);
      return { rewindingThreadKeys: remaining };
    });
  };

  const onForkFromRun = async (input: {
    readonly sourceThreadId: ThreadId;
    readonly runId: RunId;
  }) => {
    if (!activeThread || activeEnvironmentUnavailable) return;
    const targetThreadId = newThreadId();
    const targetThreadRef = scopeThreadRef(environmentId, targetThreadId);
    const result = await forkThreadFromRun({
      environmentId,
      input: {
        sourceThreadId: input.sourceThreadId,
        targetThreadId,
        runId: input.runId,
        title: `${activeThread.title} fork`,
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThread.id,
          error instanceof Error ? error.message : "Failed to fork this response.",
        );
      }
      return;
    }
    const targetThreadReady = await waitForThreadShell(targetThreadRef);
    if (!targetThreadReady) {
      setThreadError(
        activeThread.id,
        "The fork was created, but its thread data did not reach this client. Reconnect and try opening it from the sidebar.",
      );
      return;
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(targetThreadRef),
    });
  };
  const onForkFromRunStable = useStableCallback(onForkFromRun);
  const onTimelineRollbackCheckpoint = (input: {
    readonly checkpointId: string;
    readonly scopeId: string;
  }) => {
    if (!paintOnlyDisplayedTimeline) void onRollbackCheckpoint(input);
  };
  const onTimelineRollbackCheckpointStable = useStableCallback(onTimelineRollbackCheckpoint);
  const onRevertTimelineTurn = (targetTurnCount: number, messageId: MessageId) => {
    void requestMessageRewindStable(targetTurnCount, messageId);
  };
  const onRevertTimelineTurnStable = useStableCallback(onRevertTimelineTurn);

  // Esc stops a running turn; Esc twice opens the rewind picker, as in Claude Code.
  const messageRewindTargets = deriveMessageRewindTargets({
    timelineEntries,
    turnDiffSummaries,
    supportsConversationRollback,
    supportsMessageRewind,
  });
  const [rewindPickerThreadKey, setRewindPickerThreadKey] = useState<string | null>(null);
  const rewindPickerOpen = rewindPickerThreadKey === routeThreadKey;
  const rewindPickerEntries = rewindPickerOpen
    ? rewindPickerItems(timelineEntries, messageRewindTargets)
    : [];
  const keptRewindPickerThreadKey = keepRewindPickerOpen(rewindPickerThreadKey, {
    routeThreadKey,
    itemCount: rewindPickerEntries.length,
  });
  if (keptRewindPickerThreadKey !== rewindPickerThreadKey) {
    setRewindPickerThreadKey(keptRewindPickerThreadKey);
  }
  useEscapeToStopAndRewind({
    enabled: isServerThread && !paintOnlyDisplayedTimeline,
    running: canInterruptRunningThread,
    canRewind: messageRewindTargets.size > 0,
    onStop: () => void onInterrupt(),
    onOpenPicker: () => setRewindPickerThreadKey(routeThreadKey),
  });
  const onChooseRewindPickerMessage = (messageId: MessageId) => {
    setRewindPickerThreadKey(null);
    const turnCount = messageRewindTargets.get(messageId);
    if (turnCount !== undefined) void requestMessageRewindStable(turnCount, messageId);
  };
  const rewindDialogOpen =
    supportsMessageRewind &&
    pendingRewind !== null &&
    pendingRewind.routeThreadKey === routeThreadKey;
  const onCancelRewindDialog = () => setPendingRewind(null);
  const onChooseRewindDialog = (choice: ThreadRewindChoice, instructions?: string) => {
    if (!pendingRewind || pendingRewind.routeThreadKey !== routeThreadKey) return;
    setPendingRewind(null);
    void onRevertToTurnCount(pendingRewind.turnCount, pendingRewind.messageId, {
      type: "rewind",
      choice,
      ...(instructions === undefined ? {} : { instructions }),
    });
  };
  const rewindPickerProps = {
    open: rewindPickerOpen,
    items: rewindPickerEntries,
    onChoose: onChooseRewindPickerMessage,
    onCancel: () => setRewindPickerThreadKey(null),
  } satisfies ComponentProps<typeof RewindPicker>;
  return {
    rewindPickerProps,
    rewindDialogOpen,
    messageRewindMenu,
    onCancelRewindDialog,
    onChooseRewindDialog,
    onConfirmRevertStable,
    onForkFromRunStable,
    onRevertTimelineTurnStable,
    onTimelineRollbackCheckpointStable,
  };
}
