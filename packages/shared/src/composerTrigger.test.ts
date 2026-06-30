import { describe, expect, it } from "vite-plus/test";

import {
  detectComposerTrigger,
  hoistLeadingSlashCommand,
  serializeComposerMentionPath,
  startsWithSlashCommandToken,
} from "./composerTrigger.ts";

describe("serializeComposerMentionPath", () => {
  it("keeps simple mention paths unquoted", () => {
    expect(serializeComposerMentionPath("src/index.ts")).toBe("src/index.ts");
  });

  it("quotes mention paths containing whitespace", () => {
    expect(serializeComposerMentionPath("docs/My File.md")).toBe('"docs/My File.md"');
  });

  it("escapes quoted mention path content", () => {
    expect(serializeComposerMentionPath('docs/My "File".md')).toBe('"docs/My \\"File\\".md"');
  });
});

describe("detectComposerTrigger", () => {
  it("detects a slash command at the start of the input", () => {
    const text = "/mo";
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-command",
      query: "mo",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("detects a slash command typed after preceding text on the same line", () => {
    const text = "do you need to /grill-m";
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-command",
      query: "grill-m",
      rangeStart: "do you need to ".length,
      rangeEnd: text.length,
    });
  });

  it("detects a slash command at the start of a later line", () => {
    const text = "first line\n/gr";
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-command",
      query: "gr",
      rangeStart: "first line\n".length,
      rangeEnd: text.length,
    });
  });

  it("opens the command menu for a bare slash with an empty query", () => {
    expect(detectComposerTrigger("/", 1)).toEqual({
      kind: "slash-command",
      query: "",
      rangeStart: 0,
      rangeEnd: 1,
    });
  });

  it("does not treat an absolute path as a command trigger", () => {
    expect(detectComposerTrigger("ls /etc/hosts", "ls /etc/hosts".length)).toBeNull();
  });

  it("does not treat a URL or date as a command trigger", () => {
    expect(detectComposerTrigger("open /api/v1", "open /api/v1".length)).toBeNull();
    expect(detectComposerTrigger("due 6/29", "due 6/29".length)).toBeNull();
  });

  it("closes the slash menu once an argument with a space is typed", () => {
    expect(detectComposerTrigger("/model spark", "/model spark".length)).toBeNull();
  });

  it("keeps /model as a slash command (no slash-model kind)", () => {
    const text = "/model";
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-command",
      query: "model",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("detects $skill and @path tokens mid-text", () => {
    expect(detectComposerTrigger("use $gh-fi", "use $gh-fi".length)).toEqual({
      kind: "skill",
      query: "gh-fi",
      rangeStart: "use ".length,
      rangeEnd: "use $gh-fi".length,
    });
    expect(detectComposerTrigger("check @src/com", "check @src/com".length)).toEqual({
      kind: "path",
      query: "src/com",
      rangeStart: "check ".length,
      rangeEnd: "check @src/com".length,
    });
  });

  it("uses the isWhitespaceChar override to treat a custom char as a token boundary", () => {
    // "#" is not whitespace by default, so without the override the token is the
    // whole "#/gr" and nothing triggers. The override (mirroring how web treats its
    // inline terminal-context placeholder as a boundary) makes "/gr" its own token.
    const boundary = "#";
    const text = `${boundary}/gr`;
    const isWhitespaceChar = (char: string) => char === boundary;

    expect(detectComposerTrigger(text, text.length)).toBeNull();
    expect(detectComposerTrigger(text, text.length, isWhitespaceChar)).toEqual({
      kind: "slash-command",
      query: "gr",
      rangeStart: boundary.length,
      rangeEnd: text.length,
    });
  });
});

describe("startsWithSlashCommandToken", () => {
  it("is true for a leading command (optionally after whitespace)", () => {
    expect(startsWithSlashCommandToken("/grill-me on Phase 3")).toBe(true);
    expect(startsWithSlashCommandToken("  /plan")).toBe(true);
  });

  it("is false when the command is not leading", () => {
    expect(startsWithSlashCommandToken("do X then /grill-me")).toBe(false);
  });

  it("is false for path-shaped or non-command leading tokens", () => {
    expect(startsWithSlashCommandToken("/etc/hosts")).toBe(false);
    expect(startsWithSlashCommandToken("just prose")).toBe(false);
    expect(startsWithSlashCommandToken("")).toBe(false);
  });
});

describe("hoistLeadingSlashCommand", () => {
  const known = new Set(["grill-me", "default", "plan"]);

  it("hoists a single non-leading command to the front (screenshot example)", () => {
    expect(
      hoistLeadingSlashCommand("remove Someday — #495 then /grill-me on Phase 3 — #400", known),
    ).toBe("/grill-me on Phase 3 — #400\n\nremove Someday — #495 then");
  });

  it("leaves an already-leading command unchanged", () => {
    expect(hoistLeadingSlashCommand("/grill-me on Phase 3", known)).toBe("/grill-me on Phase 3");
  });

  it("leaves an unknown /foo command unchanged", () => {
    expect(hoistLeadingSlashCommand("do X then /foo bar", known)).toBe("do X then /foo bar");
  });

  it("leaves text with two recognized commands unchanged (ambiguous)", () => {
    const text = "first /grill-me then /default";
    expect(hoistLeadingSlashCommand(text, known)).toBe(text);
  });

  it("ignores a path-shaped token with a second slash", () => {
    const text = "look at /etc/hosts please";
    expect(hoistLeadingSlashCommand(text, new Set(["etc"]))).toBe(text);
  });

  it("returns the original text when nothing is recognized", () => {
    expect(hoistLeadingSlashCommand("just plain prose", known)).toBe("just plain prose");
    expect(hoistLeadingSlashCommand("anything /grill-me", new Set())).toBe("anything /grill-me");
  });
});
