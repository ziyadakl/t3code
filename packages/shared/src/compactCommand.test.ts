import { describe, expect, it } from "vite-plus/test";

import {
  isCompactCommand,
  normalizeCompactCommand,
  parseCompactCommand,
} from "./compactCommand.ts";

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

describe("normalizeCompactCommand", () => {
  it("rebuilds the command with trimmed instructions", () => {
    expect(normalizeCompactCommand(" /COMPACT ")).toBe("/compact");
    expect(normalizeCompactCommand("/Compact\n\n  keep tests ")).toBe("/compact keep tests");
    expect(parseCompactCommand(normalizeCompactCommand("/compact keep tests"))).toBe("keep tests");
  });
});
