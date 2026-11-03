import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import * as AgentSessionScanner from "./AgentSessionScanner.ts";

const encodeTranscriptRecord = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

describe("parseAgentSessionTranscript", () => {
  it("records each Claude prompt's uuid and the reply uuid its turn ended at", () => {
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: realShapedClaudeTranscript(),
      source: "claudeAgent",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
    });

    expect(thread?.messages).toEqual([
      expect.objectContaining({
        role: "user",
        text: "Create notes.md",
        nativeUserMessageId: "prompt-1",
        nativeTurnId: "reply-1-final",
      }),
      expect.not.objectContaining({ nativeUserMessageId: expect.anything() }),
      expect.not.objectContaining({ nativeUserMessageId: expect.anything() }),
      // Interrupted before Claude replied: a rewind after it resumes at the prompt.
      expect.objectContaining({
        role: "user",
        text: "Now add a title",
        nativeUserMessageId: "prompt-2",
        nativeTurnId: "prompt-2",
      }),
      expect.objectContaining({
        role: "user",
        text: "[Request interrupted by user]",
        nativeUserMessageId: "interrupt-2",
        nativeTurnId: "interrupt-2",
      }),
      expect.objectContaining({
        role: "user",
        text: "Add a title please",
        nativeUserMessageId: "prompt-3",
        nativeTurnId: "reply-3",
      }),
      expect.objectContaining({ role: "assistant", text: "Added the title." }),
    ]);
  });

  it("keeps the first copy of Claude records the desktop app wrote again", () => {
    const record = (type: "user" | "assistant", uuid: string, extra?: object) =>
      encodeTranscriptRecord({
        type,
        uuid,
        sessionId: "claude-session",
        timestamp: "2026-08-24T10:00:00.000Z",
        message: { role: type, content: uuid },
        ...extra,
      });
    const again = { slug: "rewritten", gitBranch: "main", promptId: "again" };
    const transcript = [
      record("user", "prompt-1"),
      record("assistant", "reply-1"),
      record("user", "prompt-2"),
      record("assistant", "reply-2"),
      record("assistant", "reply-1", again),
      record("user", "prompt-1", again),
      record("user", "prompt-3"),
      record("assistant", "reply-3"),
    ].join("\n");
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: transcript,
      source: "claudeAgent",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
      allMessages: true,
    });
    expect(thread?.messages.map((message) => message.text)).toEqual([
      "prompt-1",
      "reply-1",
      "prompt-2",
      "reply-2",
      "prompt-3",
      "reply-3",
    ]);
    // The second turn ends at its own reply, not at the copy written after it.
    expect(thread?.messages[2]).toMatchObject({
      nativeUserMessageId: "prompt-2",
      nativeTurnId: "reply-2",
    });
  });
  it("ends the first Claude turn where the span dropped by the message limit ends", () => {
    const record = (type: "user" | "assistant", uuid: string) =>
      encodeTranscriptRecord({
        type,
        uuid,
        sessionId: "claude-session",
        message: { role: type, content: uuid },
      });
    const transcript = [
      record("user", "prompt-first"),
      record("assistant", "reply-first"),
      ...Array.from({ length: 150 }, (_, index) => [
        record("user", `prompt-${index}`),
        record("assistant", `reply-${index}`),
      ]).flat(),
    ].join("\n");

    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: transcript,
      source: "claudeAgent",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
    });

    expect(thread?.messages.slice(0, 3)).toEqual([
      expect.objectContaining({ nativeUserMessageId: "prompt-first", nativeTurnId: "reply-50" }),
      expect.objectContaining({ role: "assistant", text: "reply-50" }),
      expect.objectContaining({ nativeUserMessageId: "prompt-51", nativeTurnId: "reply-51" }),
    ]);
  });
});

/** A Claude Code CLI transcript as written to disk, trimmed to the records that matter. */
function realShapedClaudeTranscript(): string {
  const session = { sessionId: "claude-session", cwd: "/project", version: "2.1.276" };
  const at = (second: number) => `2026-08-24T10:00:${String(second).padStart(2, "0")}.000Z`;
  return [
    {
      type: "queue-operation",
      operation: "enqueue",
      timestamp: at(0),
      sessionId: "claude-session",
    },
    { ...session, type: "attachment", uuid: "attachment-0", parentUuid: null, timestamp: at(0) },
    {
      ...session,
      type: "user",
      uuid: "prompt-1",
      parentUuid: "attachment-0",
      promptId: "p1",
      timestamp: at(1),
      message: { role: "user", content: "Create notes.md" },
    },
    {
      ...session,
      type: "user",
      isMeta: true,
      uuid: "meta-1",
      parentUuid: "prompt-1",
      timestamp: at(1),
      message: { role: "user", content: "<system-reminder>skill text</system-reminder>" },
    },
    {
      type: "file-history-snapshot",
      messageId: "prompt-1",
      snapshot: { messageId: "prompt-1", trackedFileBackups: {}, timestamp: at(1) },
      isSnapshotUpdate: false,
    },
    {
      ...session,
      type: "assistant",
      uuid: "reply-1-thinking",
      parentUuid: "meta-1",
      timestamp: at(2),
      message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "thinking" }] },
    },
    {
      ...session,
      type: "assistant",
      uuid: "reply-1-text",
      parentUuid: "reply-1-thinking",
      timestamp: at(3),
      message: {
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: "Creating it." }],
      },
    },
    {
      ...session,
      type: "assistant",
      uuid: "reply-1-tool",
      parentUuid: "reply-1-text",
      timestamp: at(4),
      message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use" }] },
    },
    {
      ...session,
      type: "user",
      uuid: "tool-result-1",
      parentUuid: "reply-1-tool",
      promptId: "p1",
      timestamp: at(5),
      message: { role: "user", content: [{ type: "tool_result" }] },
    },
    {
      type: "file-history-snapshot",
      messageId: "prompt-1",
      snapshot: {
        messageId: "prompt-1",
        trackedFileBackups: { "notes.md": { backupFileName: null, version: 1 } },
        timestamp: at(5),
      },
      isSnapshotUpdate: true,
    },
    {
      ...session,
      type: "assistant",
      uuid: "reply-1-final",
      parentUuid: "tool-result-1",
      timestamp: at(6),
      message: {
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: "Created notes.md." }],
      },
    },
    {
      ...session,
      type: "system",
      uuid: "system-1",
      parentUuid: "reply-1-final",
      timestamp: at(6),
    },
    { type: "last-prompt", leafUuid: "system-1", sessionId: "claude-session" },
    {
      ...session,
      type: "user",
      uuid: "prompt-2",
      parentUuid: "system-1",
      promptId: "p2",
      timestamp: at(7),
      message: { role: "user", content: [{ type: "text", text: "Now add a title" }] },
    },
    {
      ...session,
      type: "user",
      uuid: "interrupt-2",
      parentUuid: "prompt-2",
      timestamp: at(8),
      message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
    },
    {
      ...session,
      type: "user",
      uuid: "prompt-3",
      parentUuid: "interrupt-2",
      promptId: "p3",
      timestamp: at(9),
      message: { role: "user", content: "Add a title please" },
    },
    {
      ...session,
      type: "assistant",
      isSidechain: true,
      uuid: "subagent-reply",
      parentUuid: "prompt-3",
      timestamp: at(10),
      message: {
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: "Subagent work" }],
      },
    },
    {
      ...session,
      type: "assistant",
      uuid: "reply-3",
      parentUuid: "prompt-3",
      timestamp: at(11),
      message: {
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: "Added the title." }],
      },
    },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n");
}
