import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { buildReplayCommands, planReplayCommands } from "./transcriptReplay.ts";

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
      // ADR-0002: the Claude transcript uuid is the rewind anchor.
      expect(command.providerMessageUuid).toBe("u1");
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
      // ADR-0002: the assistant message carries its rewind-anchor uuid.
      expect(delta.providerMessageUuid).toBe("a1");
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

  it("does not cap or add a notice when within the limit", () => {
    const messages = [
      { type: "user" as const, uuid: "u1", message: { role: "user", content: "a" } },
      { type: "user" as const, uuid: "u2", message: { role: "user", content: "b" } },
    ];
    const commands = planReplayCommands(messages, ctx, 2);
    expect(commands).toHaveLength(2);
    expect(commands.every((c) => c.type === "thread.message.user.record")).toBe(true);
  });

  it("caps to the last N messages and prepends a truncation notice", () => {
    const messages = [
      { type: "user" as const, uuid: "u1", message: { role: "user", content: "oldest" } },
      { type: "user" as const, uuid: "u2", message: { role: "user", content: "middle" } },
      { type: "user" as const, uuid: "u3", message: { role: "user", content: "newest" } },
    ];
    const commands = planReplayCommands(messages, ctx, 2);

    // notice (assistant delta+complete) + last 2 user messages = 4 commands
    expect(commands.map((c) => c.type)).toEqual([
      "thread.message.assistant.delta",
      "thread.message.assistant.complete",
      "thread.message.user.record",
      "thread.message.user.record",
    ]);
    const notice = commands[0];
    if (notice?.type === "thread.message.assistant.delta") {
      expect(notice.delta).toContain("last 2 of 3");
    }
    // the dropped "oldest" message is not present
    const texts = commands.flatMap((c) =>
      c.type === "thread.message.user.record" ? [c.text] : [],
    );
    expect(texts).toEqual(["middle", "newest"]);
  });

  it("uses totalMessageCount for the notice when the caller pre-slices the array", () => {
    // Simulate the ResumeSeedReactor pre-slice path: caller already sliced to
    // last 2 messages but passes totalMessageCount=3 so the notice is accurate.
    const messages = [
      { type: "user" as const, uuid: "u2", message: { role: "user", content: "middle" } },
      { type: "user" as const, uuid: "u3", message: { role: "user", content: "newest" } },
    ];
    const commands = planReplayCommands(messages, ctx, 2, 3);

    // notice (assistant delta+complete) + 2 user messages = 4 commands
    expect(commands.map((c) => c.type)).toEqual([
      "thread.message.assistant.delta",
      "thread.message.assistant.complete",
      "thread.message.user.record",
      "thread.message.user.record",
    ]);
    const notice = commands[0];
    if (notice?.type === "thread.message.assistant.delta") {
      expect(notice.delta).toContain("last 2 of 3");
    }
  });
});

describe("slash-command / skill invocations", () => {
  const userText = (content: string) =>
    buildReplayCommands([{ type: "user", uuid: "u", message: { role: "user", content } }], ctx).find(
      (c) => c.type === "thread.message.user.record",
    );

  it("renders a command invocation as the plain command, not raw XML tags", () => {
    // The exact shape terminal Claude writes to the transcript for a slash command.
    const command = userText(
      "<command-name>/sandcastle-status</command-name>\n            <command-message>sandcastle-status</command-message>\n            <command-args></command-args>",
    );
    expect(command?.type).toBe("thread.message.user.record");
    if (command?.type === "thread.message.user.record") {
      expect(command.text).toBe("/sandcastle-status");
      expect(command.text).not.toContain("<command-name>");
      expect(command.text).not.toContain("<command-message>");
    }
  });

  it("appends args and tolerates message-before-name tag order", () => {
    const command = userText(
      "<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>--fix src/foo.ts</command-args>",
    );
    if (command?.type === "thread.message.user.record") {
      expect(command.text).toBe("/review --fix src/foo.ts");
    }
  });

  it("leaves ordinary prompts (no command wrapper) unchanged", () => {
    const command = userText("just a normal message");
    if (command?.type === "thread.message.user.record") {
      expect(command.text).toBe("just a normal message");
    }
  });
});
