import {
  EventId,
  MessageId,
  NodeId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * The records a finished Claude turn T3 Code ran on an imported thread leaves:
 * its run, attempt, root node, provider turn on the import's provider thread,
 * the prompt and the reply. `nativeReplyId` is the reply's transcript uuid.
 */
export function claudeTurnRunInT3Code(input: {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly ordinal: number;
  readonly providerTurnOrdinal: number;
  readonly prompt: string;
  readonly reply: string;
  readonly nativeReplyId: string;
  readonly at: string;
  /** The run's id; the orchestrator derives it from the thread and ordinal. */
  readonly runId?: RunId;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const threadId = input.providerThread.appThreadId!;
  const name = `t3-code-turn-${input.ordinal}`;
  const runId = input.runId ?? RunId.make(`run:${name}`);
  const nodeId = NodeId.make(`node:${name}`);
  const attemptId = RunAttemptId.make(`attempt:${name}`);
  const providerTurnId = ProviderTurnId.make(`provider-turn:${name}`);
  const promptId = MessageId.make(`message:${name}:prompt`);
  const at = DateTime.makeUnsafe(input.at);
  const driver = input.providerThread.driver;
  const providerInstanceId = input.providerThread.providerInstanceId;
  const message = (id: MessageId, role: "user" | "assistant", text: string) =>
    ({
      id: EventId.make(`event:${id}`),
      type: "message.updated",
      threadId,
      occurredAt: at,
      payload: {
        createdBy: role === "user" ? "user" : "agent",
        creationSource: role === "user" ? "web" : "server",
        id,
        threadId,
        runId,
        nodeId,
        role,
        text,
        attachments: [],
        streaming: false,
        createdAt: at,
        updatedAt: at,
      },
    }) satisfies OrchestrationV2DomainEvent;
  return [
    message(promptId, "user", input.prompt),
    {
      id: EventId.make(`event:${name}:run`),
      type: "run.created",
      threadId,
      runId,
      occurredAt: at,
      payload: {
        id: runId,
        threadId,
        ordinal: input.ordinal,
        providerInstanceId,
        modelSelection: { instanceId: providerInstanceId, model: "claude-opus-5" },
        providerThreadId: input.providerThread.id,
        userMessageId: promptId,
        rootNodeId: nodeId,
        activeAttemptId: attemptId,
        status: "completed",
        requestedAt: at,
        startedAt: at,
        completedAt: at,
        checkpointId: null,
        contextHandoffId: null,
      },
    },
    {
      id: EventId.make(`event:${name}:attempt`),
      type: "run-attempt.created",
      threadId,
      runId,
      occurredAt: at,
      payload: {
        id: attemptId,
        ...(input.providerThread.nativeThreadRef?.nativeId == null
          ? {}
          : { nativeThreadId: input.providerThread.nativeThreadRef.nativeId }),
        runId,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId,
        providerThreadId: input.providerThread.id,
        providerTurnId,
        reason: "initial",
        status: "completed",
        startedAt: at,
        completedAt: at,
      },
    },
    {
      id: EventId.make(`event:${name}:node`),
      type: "node.updated",
      threadId,
      runId,
      nodeId,
      occurredAt: at,
      payload: {
        id: nodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: "root_turn",
        status: "completed",
        countsForRun: true,
        providerThreadId: input.providerThread.id,
        providerTurnId,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: at,
        completedAt: at,
      },
    },
    {
      id: EventId.make(`event:${name}:provider-turn`),
      type: "provider-turn.updated",
      threadId,
      runId,
      driver,
      occurredAt: at,
      payload: {
        id: providerTurnId,
        providerThreadId: input.providerThread.id,
        nodeId,
        runAttemptId: attemptId,
        nativeTurnRef: { driver, nativeId: input.nativeReplyId, strength: "strong" },
        ordinal: input.providerTurnOrdinal,
        status: "completed",
        startedAt: at,
        completedAt: at,
      },
    },
    message(MessageId.make(`message:${name}:reply`), "assistant", input.reply),
    {
      id: EventId.make(`event:${name}:provider-thread`),
      type: "provider-thread.updated",
      threadId,
      driver,
      providerInstanceId,
      occurredAt: at,
      payload: {
        ...input.providerThread,
        firstRunOrdinal: input.providerThread.firstRunOrdinal ?? input.ordinal,
        lastRunOrdinal: input.ordinal,
        updatedAt: at,
      },
    },
  ];
}
