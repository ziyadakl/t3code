import { describe, expect, it } from "vite-plus/test";

import { formatCompactCommand, isCompactCommand, parseCompactCommand } from "./compactCommand.ts";

describe("parseCompactCommand", () => {
  it("reads a bare /compact in any case and spacing", () => {
    expect(parseCompactCommand("/compact")).toBe("");
    expect(parseCompactCommand("  /COMPACT \n")).toBe("");
  });

  it("returns the instructions after the command", () => {
    expect(parseCompactCommand("/compact keep the auth rewrite")).toBe("keep the auth rewrite");
    expect(parseCompactCommand(" /Compact\n  focus on\n the tests  ")).toBe("focus on\n the tests");
  });

  it("rejects other words and commands", () => {
    expect(parseCompactCommand("/compacting")).toBeNull();
    expect(parseCompactCommand("/compactx keep")).toBeNull();
    expect(parseCompactCommand("please /compact")).toBeNull();
    expect(parseCompactCommand("/goal compact")).toBeNull();
    expect(isCompactCommand("/compacting")).toBe(false);
    expect(isCompactCommand("/compact now")).toBe(true);
  });
});

describe("formatCompactCommand", () => {
  it("round-trips through the parser", () => {
    expect(formatCompactCommand("")).toBe("/compact");
    expect(formatCompactCommand("  keep tests ")).toBe("/compact keep tests");
    expect(parseCompactCommand(formatCompactCommand("keep tests"))).toBe("keep tests");
  });
});
