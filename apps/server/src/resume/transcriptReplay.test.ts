import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { buildReplayCommands } from "./transcriptReplay.ts";

const ctx = {
  threadId: ThreadId.make("thread-replay"),
  sessionId: "0ed4e913-e0cf-4256-bc48-9ab382ddfc64",
  baseTimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
};

describe("buildReplayCommands", () => {
  it("maps a plain-string user message to a single user.record command", () => {
    const commands = buildReplayCommands(
      [{ type: "user", uuid: "u1", message: { role: "user", content: "fix the budget calc" } }],
      ctx,
    );

    expect(commands).toHaveLength(1);
    const [command] = commands;
    expect(command?.type).toBe("thread.message.user.record");
    if (command?.type === "thread.message.user.record") {
      expect(command.threadId).toBe(ctx.threadId);
      expect(command.text).toBe("fix the budget calc");
      // deterministic id + monotonic timestamp for idempotent, ordered replay
      expect(command.commandId).toBe(`server:resume-replay:${ctx.sessionId}:0`);
      expect(command.createdAt).toBe("2026-01-01T00:00:00.000Z");
    }
  });

  it("maps an assistant message to a delta(full text) + complete pair on one messageId", () => {
    const commands = buildReplayCommands(
      [
        {
          type: "assistant",
          uuid: "a1",
          message: { role: "assistant", content: [{ type: "text", text: "done, added it" }] },
        },
      ],
      ctx,
    );

    expect(commands.map((c) => c.type)).toEqual([
      "thread.message.assistant.delta",
      "thread.message.assistant.complete",
    ]);
    const [delta, complete] = commands;
    if (delta?.type === "thread.message.assistant.delta") {
      expect(delta.delta).toBe("done, added it");
      expect(delta.messageId).toBe("resume:a1");
    }
    if (complete?.type === "thread.message.assistant.complete") {
      // same messageId so complete finalizes the message delta created
      expect(complete.messageId).toBe("resume:a1");
    }
  });

  it("preserves order with strictly monotonic timestamps across messages", () => {
    const commands = buildReplayCommands(
      [
        { type: "user", uuid: "u1", message: { role: "user", content: "first" } },
        {
          type: "assistant",
          uuid: "a1",
          message: { role: "assistant", content: [{ type: "text", text: "reply" }] },
        },
      ],
      ctx,
    );

    expect(commands.map((c) => c.type)).toEqual([
      "thread.message.user.record",
      "thread.message.assistant.delta",
      "thread.message.assistant.complete",
    ]);
    const times = commands.map((c) => Date.parse(c.createdAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(times.length); // all distinct
  });

  it("extracts text from array content and skips empty / non-text messages", () => {
    const commands = buildReplayCommands(
      [
        { type: "user", uuid: "u1", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
        { type: "system", uuid: "s1", message: { role: "system", content: "ignored" } } as never,
        { type: "assistant", uuid: "a1", message: { role: "assistant", content: [] } },
      ],
      ctx,
    );

    // only the array-text user message survives; system is not user/assistant,
    // and the empty-content assistant produces nothing.
    expect(commands).toHaveLength(1);
    expect(commands[0]?.type).toBe("thread.message.user.record");
    if (commands[0]?.type === "thread.message.user.record") {
      expect(commands[0].text).toBe("hi");
    }
  });
});
