import { describe, expect, it } from "vite-plus/test";

import { planClaudeSkillDispatch } from "./ClaudeSkillDispatch.ts";

const SKILLS = new Set(["2spec", "implement", "review", "re-release-version"]);

describe("planClaudeSkillDispatch", () => {
  it("leaves a prompt without a known skill untouched", () => {
    expect(planClaudeSkillDispatch("fix the build", SKILLS)).toBeUndefined();
    // Not a discovered skill, so it stays prose rather than becoming a command.
    expect(planClaudeSkillDispatch("echo $HOME then $unknown", SKILLS)).toBeUndefined();
  });

  it("moves a mid-prompt mention into a trailing slash command", () => {
    expect(planClaudeSkillDispatch("ok, now $implement all the tickets", SKILLS)).toEqual({
      leadingText: "ok, now",
      commandText: "/implement all the tickets",
      skillName: "implement",
    });
  });

  it("keeps a mention that opens the prompt as a single command block", () => {
    expect(planClaudeSkillDispatch("$review\nfocus on auth", SKILLS)).toEqual({
      leadingText: undefined,
      commandText: "/review\nfocus on auth",
      skillName: "review",
    });
  });

  it("dispatches a known skill whose name begins with a digit", () => {
    expect(planClaudeSkillDispatch("use $2spec for this", SKILLS)).toEqual({
      leadingText: "use",
      commandText: "/2spec for this",
      skillName: "2spec",
    });
  });

  it("dispatches the last mention and rewrites earlier ones inline", () => {
    expect(planClaudeSkillDispatch("$review the diff, then $implement the fixes", SKILLS)).toEqual({
      leadingText: "/review the diff, then",
      commandText: "/implement the fixes",
      skillName: "implement",
    });
  });

  it("dispatches currency-prefixed mentions and preserves their source boundaries", () => {
    for (const symbol of ["€", "£", "¥", "₹", "₩", "₿", "𑿝"]) {
      expect(
        planClaudeSkillDispatch(
          `${symbol}review the diff, then ${symbol}implement the fixes`,
          SKILLS,
        ),
      ).toEqual({
        leadingText: "/review the diff, then",
        commandText: "/implement the fixes",
        skillName: "implement",
      });
      expect(planClaudeSkillDispatch(`${symbol}2spec for this`, SKILLS)).toEqual({
        leadingText: undefined,
        commandText: "/2spec for this",
        skillName: "2spec",
      });
      expect(planClaudeSkillDispatch(`5${symbol}review ${symbol}unknown`, SKILLS)).toBeUndefined();
    }
  });

  it("dispatches a typed slash command that ends the prompt", () => {
    expect(planClaudeSkillDispatch("hey there. audit the checks\n\n/review", SKILLS)).toEqual({
      leadingText: "hey there. audit the checks",
      commandText: "/review",
      skillName: "review",
    });
  });

  it("dispatches a typed plugin slash command, which skill discovery does not list", () => {
    expect(
      planClaudeSkillDispatch("see what checks we have\n\n/mattpocock-skills:ask-matt", SKILLS),
    ).toEqual({
      leadingText: "see what checks we have",
      commandText: "/mattpocock-skills:ask-matt",
      skillName: "mattpocock-skills:ask-matt",
    });
  });

  it("drops sentence punctuation after a typed command", () => {
    expect(planClaudeSkillDispatch("try /mattpocock-skills:ask-matt? thanks", SKILLS)).toEqual({
      leadingText: "try",
      commandText: "/mattpocock-skills:ask-matt thanks",
      skillName: "mattpocock-skills:ask-matt",
    });
    expect(planClaudeSkillDispatch("then run /review.", SKILLS)).toEqual({
      leadingText: "then run",
      commandText: "/review",
      skillName: "review",
    });
  });

  it("orders typed and chip mentions by position, dispatching the last", () => {
    expect(planClaudeSkillDispatch("/review first, then $implement it", SKILLS)).toEqual({
      leadingText: "/review first, then",
      commandText: "/implement it",
      skillName: "implement",
    });
    expect(planClaudeSkillDispatch("$review first, then /implement it", SKILLS)).toEqual({
      leadingText: "/review first, then",
      commandText: "/implement it",
      skillName: "implement",
    });
  });

  it("leaves typed slashes that are not commands as prose", () => {
    expect(planClaudeSkillDispatch("read /etc/hosts and /unknown", SKILLS)).toBeUndefined();
    expect(planClaudeSkillDispatch("open src/review now", SKILLS)).toBeUndefined();
  });

  it("ignores a dollar token glued to other text", () => {
    expect(planClaudeSkillDispatch("cost is 5$implement", SKILLS)).toBeUndefined();
  });

  it("ignores currency amounts and compact monetary expressions", () => {
    const skillsWithCurrency = new Set([...SKILLS, "20", "20k", "100M", "1e6"]);
    for (const symbol of ["$", "€", "£", "¥", "₹", "₩", "₿", "𑿝"]) {
      expect(
        planClaudeSkillDispatch(
          `pay ${symbol}20 ${symbol}20k ${symbol}100M ${symbol}1e6 tomorrow`,
          skillsWithCurrency,
        ),
      ).toBeUndefined();
    }
  });
});
