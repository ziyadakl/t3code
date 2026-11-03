import { MessageId, ThreadId, type OrchestrationV2Run } from "@t3tools/contracts";

import { isImportedTranscriptRun } from "../orchestration-v2/ThreadRewindTargets.ts";
import type { AgentSessionThread, AgentSessionThreadMessage } from "./AgentSessionScanner.ts";

// Pure helpers for a Claude transcript imported into a thread, and for the uuids a rewind needs:
// no services, no I/O. The scanner uses `withClaudeTurnIds`; the importer's records use the rest.

/** Where a Claude record sits in its transcript, for working out turn ends. */
export interface ClaudeRecordPosition {
  readonly uuid: string | undefined;
  readonly recordIndex: number;
  /** The last main-chain reply written before this record. */
  readonly replyBefore: { readonly uuid: string; readonly recordIndex: number } | undefined;
}

export type ParsedMessage = AgentSessionThreadMessage & {
  readonly codexResponseUser: boolean;
  readonly claude?: ClaudeRecordPosition;
};

/**
 * Gives each retained Claude prompt its uuid and the uuid its turn ended at.
 * A turn runs until the next retained prompt, so a prompt before messages the
 * import cap dropped ends where the dropped span ends.
 */
export function withClaudeTurnIds(
  messages: ReadonlyArray<ParsedMessage>,
  lastReply: ClaudeRecordPosition["replyBefore"],
): ReadonlyArray<AgentSessionThreadMessage> {
  return messages.map(({ codexResponseUser: _codexResponseUser, claude, ...message }, index) => {
    if (message.role !== "user" || claude?.uuid === undefined) return message;
    const nextPrompt = messages.slice(index + 1).find((candidate) => candidate.role === "user");
    const turnEnd = nextPrompt === undefined ? lastReply : nextPrompt.claude?.replyBefore;
    return {
      ...message,
      nativeUserMessageId: claude.uuid,
      nativeTurnId:
        turnEnd !== undefined && turnEnd.recordIndex > claude.recordIndex
          ? turnEnd.uuid
          : claude.uuid,
    };
  });
}

const IMPORTED_THREAD_PREFIX = "import:";

/** The thread an agent session is imported into, one per provider session. */
export function importedThreadId(session: {
  readonly providerInstanceId: string;
  readonly providerSessionId: string;
}): ThreadId {
  return ThreadId.make(
    `${IMPORTED_THREAD_PREFIX}${session.providerInstanceId}:${session.providerSessionId}`,
  );
}

/** Whether `threadId` was made by `importedThreadId`, not started in T3 Code. */
export function isImportedThreadId(threadId: ThreadId): boolean {
  return threadId.startsWith(IMPORTED_THREAD_PREFIX);
}

/** Starts with the thread id, which is how `isImportedTranscriptRun` tells imported runs apart. */
export function importedMessageId(threadId: ThreadId, index: number): MessageId {
  return MessageId.make(`${threadId}:${String(index).padStart(6, "0")}`);
}

/** Whether `run` is a transcript prompt the importer wrote that was not rewound since. */
export function isImportedRun(threadId: ThreadId, run: OrchestrationV2Run): boolean {
  return run.threadId === threadId && isImportedTranscriptRun(run) && run.status === "completed";
}

export const SETTLED_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

/** One imported Claude prompt and the messages of its turn, by message index. */
export interface ImportedTurn {
  readonly userIndex: number;
  readonly lastIndex: number;
  readonly nativeUserMessageId: string;
  readonly nativeTurnId: string;
  /** Where a rewind to before the first turn resumes, when its prompt is not the transcript's first. */
  readonly nativeResumeAt?: string;
}

/**
 * Splits a Claude transcript into prompt turns, each to be recorded as a
 * completed run whose provider turn holds the uuids a rewind needs. Empty
 * when any prompt lacks them, since a partial set would rewind to the wrong
 * point.
 */
export function importedTurns(thread: AgentSessionThread): ReadonlyArray<ImportedTurn> {
  if (thread.source !== "claudeAgent" || thread.messages[0]?.role !== "user") return [];
  const turns: Array<ImportedTurn> = [];
  for (const [index, message] of thread.messages.entries()) {
    if (message.role === "assistant") {
      const current = turns.at(-1);
      if (current !== undefined) turns[turns.length - 1] = { ...current, lastIndex: index };
      continue;
    }
    if (message.nativeUserMessageId === undefined || message.nativeTurnId === undefined) return [];
    turns.push({
      userIndex: index,
      lastIndex: index,
      nativeUserMessageId: message.nativeUserMessageId,
      nativeTurnId: message.nativeTurnId,
    });
  }
  return turns;
}

/** A message of an imported thread and the transcript line it is, when known for certain. */
export interface PlacedMessage {
  readonly message: AgentSessionThreadMessage;
  readonly transcriptIndex: number | undefined;
}

/**
 * Finds each stored message of an import in its whole transcript: by the
 * prompt uuid its run already recorded, otherwise by role, text and time.
 * Matches must keep the stored order. A message that matches no line, several
 * lines, or a line out of order stays unplaced, and `unplaced` says why.
 */
export function placeStoredMessages(
  stored: ReadonlyArray<{
    readonly id: MessageId;
    readonly message: AgentSessionThreadMessage;
    readonly nativeUserMessageId: string | undefined;
  }>,
  transcript: ReadonlyArray<AgentSessionThreadMessage>,
): {
  readonly placed: ReadonlyArray<PlacedMessage>;
  readonly unplaced: ReadonlyArray<{ readonly messageId: MessageId; readonly reason: string }>;
} {
  const keyOf = (message: AgentSessionThreadMessage) =>
    `${message.role}\n${Date.parse(message.createdAt)}\n${message.text}`;
  const linesByKey = new Map<string, Array<number>>();
  const lineByUuid = new Map<string, number>();
  transcript.forEach((message, index) => {
    const key = keyOf(message);
    linesByKey.set(key, [...(linesByKey.get(key) ?? []), index]);
    if (message.nativeUserMessageId !== undefined)
      lineByUuid.set(message.nativeUserMessageId, index);
  });
  const storedPerKey = new Map<string, number>();
  for (const { message } of stored) {
    storedPerKey.set(keyOf(message), (storedPerKey.get(keyOf(message)) ?? 0) + 1);
  }
  const unplaced: Array<{ readonly messageId: MessageId; readonly reason: string }> = [];
  let previous = -1;
  const placed = stored.map(({ id, message, nativeUserMessageId }): PlacedMessage => {
    const key = keyOf(message);
    const byUuid =
      nativeUserMessageId === undefined ? undefined : lineByUuid.get(nativeUserMessageId);
    const candidates =
      nativeUserMessageId !== undefined
        ? byUuid !== undefined && keyOf(transcript[byUuid]!) === key
          ? [byUuid]
          : []
        : (storedPerKey.get(key) ?? 0) > 1
          ? undefined
          : (linesByKey.get(key) ?? []);
    const reason =
      candidates === undefined
        ? "the thread holds it more than once"
        : candidates.length === 0
          ? "no transcript line matches it"
          : candidates.length > 1
            ? `it matches ${candidates.length} transcript lines`
            : candidates[0]! <= previous
              ? "its transcript line comes before the previous message's"
              : undefined;
    if (reason !== undefined) {
      unplaced.push({ messageId: id, reason });
      return { message, transcriptIndex: undefined };
    }
    previous = candidates![0]!;
    return { message, transcriptIndex: previous };
  });
  return { placed, unplaced };
}

/**
 * The turns of an import whose messages are placed in their whole Claude transcript: one
 * per placed prompt, holding every message up to the next one and ending at the transcript's
 * last reply before it (before `endBefore` for the last). If the first placed prompt is not
 * the transcript's first, its turn keeps where the transcript before it ends.
 */
export function placedTurns(
  placed: ReadonlyArray<PlacedMessage>,
  transcript: ReadonlyArray<AgentSessionThreadMessage>,
  endBefore: number,
): ReadonlyArray<ImportedTurn> {
  const isPrompt = (index: number | undefined) =>
    index !== undefined &&
    transcript[index]?.role === "user" &&
    transcript[index].nativeUserMessageId !== undefined;
  // Where a session resumed just after the turn of the prompt at `index` continues.
  const resumeIdAt = (index: number) =>
    transcript[index]!.nativeTurnId ?? transcript[index]!.nativeUserMessageId!;
  const firstPrompt = transcript.findIndex((message) => message.role === "user");
  if (!isPrompt(firstPrompt)) return [];
  const starts = placed.flatMap((entry, index) => (isPrompt(entry.transcriptIndex) ? [index] : []));
  if (starts.length === 0) return [];
  // The transcript's turn before the first placed prompt ends where its session resumes.
  let prior = placed[starts[0]!]!.transcriptIndex! - 1;
  while (prior >= 0 && !isPrompt(prior)) prior -= 1;
  const nativeResumeAt = prior < 0 ? undefined : resumeIdAt(prior);
  return starts.map((userIndex, turn) => {
    const next = starts[turn + 1];
    let end = (next === undefined ? endBefore : placed[next]!.transcriptIndex!) - 1;
    while (!isPrompt(end)) end -= 1;
    const prompt = transcript[placed[userIndex]!.transcriptIndex!]!;
    return {
      userIndex,
      lastIndex: next === undefined ? placed.length - 1 : next - 1,
      nativeUserMessageId: prompt.nativeUserMessageId!,
      nativeTurnId: resumeIdAt(end),
      ...(turn === 0 && nativeResumeAt !== undefined ? { nativeResumeAt } : {}),
    };
  });
}
