import { describe, expect, it } from "vite-plus/test";

import { planClaudeSkillDispatch, type ClaudeSkillTarget } from "./ClaudeSkillDispatch.ts";

const skillPath = (name: string) => `/home/me/.claude/skills/${name}/SKILL.md`;

const skillMap = (names: Iterable<string>) =>
  new Map<string, ClaudeSkillTarget>([...names].map((name) => [name, { path: skillPath(name) }]));

const SKILLS = skillMap([
  "2spec",
  "implement",
  "review",
  "re-release-version",
  "mattpocock-skills:ask-matt",
]);

describe("planClaudeSkillDispatch", () => {
  // regression: #9128 skills picked from the composer did not run
  it("leaves a prompt without a known skill untouched", () => {
    expect(planClaudeSkillDispatch("fix the build", SKILLS)).toBeUndefined();
    expect(planClaudeSkillDispatch("echo $HOME then $unknown", SKILLS)).toBeUndefined();
  });

  it("keeps the whole request ahead of a mid-prompt slash command", () => {
    expect(planClaudeSkillDispatch("ok, now $implement all the tickets", SKILLS)).toEqual({
      leadingText: "ok, now /implement all the tickets",
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

  it("dispatches the last mention and rewrites earlier ones inline", () => {
    expect(planClaudeSkillDispatch("$review the diff, then $implement the fixes", SKILLS)).toEqual({
      leadingText: "/review the diff, then /implement the fixes",
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
        leadingText: "/review the diff, then /implement the fixes",
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
      leadingText: "hey there. audit the checks\n\n/review",
      commandText: "/review",
      skillName: "review",
    });
  });

  it("dispatches a typed plugin slash command that discovery lists", () => {
    expect(
      planClaudeSkillDispatch("see what checks we have\n\n/mattpocock-skills:ask-matt", SKILLS),
    ).toEqual({
      leadingText: "see what checks we have\n\n/mattpocock-skills:ask-matt",
      commandText: "/mattpocock-skills:ask-matt",
      skillName: "mattpocock-skills:ask-matt",
    });
  });

  it("drops sentence punctuation after a typed command", () => {
    expect(planClaudeSkillDispatch("try /mattpocock-skills:ask-matt? thanks", SKILLS)).toEqual({
      leadingText: "try /mattpocock-skills:ask-matt thanks",
      commandText: "/mattpocock-skills:ask-matt thanks",
      skillName: "mattpocock-skills:ask-matt",
    });
    expect(planClaudeSkillDispatch("then run /review.", SKILLS)).toEqual({
      leadingText: "then run /review",
      commandText: "/review",
      skillName: "review",
    });
  });

  it("orders typed and chip mentions by position, dispatching the last", () => {
    expect(planClaudeSkillDispatch("/review first, then $implement it", SKILLS)).toEqual({
      leadingText: "/review first, then /implement it",
      commandText: "/implement it",
      skillName: "implement",
    });
    expect(planClaudeSkillDispatch("$review first, then /implement it", SKILLS)).toEqual({
      leadingText: "/review first, then /implement it",
      commandText: "/implement it",
      skillName: "implement",
    });
  });

  it("leaves an unknown plugin-shaped slash command as prose", () => {
    expect(planClaudeSkillDispatch("compare /foo:bar and /a:b", SKILLS)).toBeUndefined();
    expect(planClaudeSkillDispatch("ratio is /16:9 here", SKILLS)).toBeUndefined();
  });

  it("leaves typed slashes that are not commands as prose", () => {
    expect(planClaudeSkillDispatch("read /etc/hosts and /unknown", SKILLS)).toBeUndefined();
    expect(planClaudeSkillDispatch("open src/review now", SKILLS)).toBeUndefined();
  });

  it("ignores a dollar token glued to other text", () => {
    expect(planClaudeSkillDispatch("cost is 5$implement", SKILLS)).toBeUndefined();
  });

  it("ignores currency amounts and compact monetary expressions", () => {
    const skillsWithCurrency = skillMap([...SKILLS.keys(), "20", "20k", "100M", "1e6"]);
    for (const symbol of ["$", "€", "£", "¥", "₹", "₩", "₿", "𑿝"]) {
      expect(
        planClaudeSkillDispatch(
          `pay ${symbol}20 ${symbol}20k ${symbol}100M ${symbol}1e6 tomorrow`,
          skillsWithCurrency,
        ),
      ).toBeUndefined();
    }
  });

  it("bounds notes for repeated user-only skills and leaves the native dispatch unannotated", () => {
    const skills = new Map([
      ["interrogate", { path: skillPath("interrogate"), userInvocationOnly: true }],
      ["implement", { path: skillPath("implement"), userInvocationOnly: true }],
    ]);
    expect(
      planClaudeSkillDispatch(
        "$interrogate then $interrogate then $implement and $implement the fixes",
        skills,
      ),
    ).toEqual({
      leadingText: `/interrogate [The user invoked this skill. Follow the instructions at: ${skillPath("interrogate")}] then /interrogate then /implement and /implement the fixes`,
      commandText: "/implement the fixes",
      skillName: "implement",
    });
  });
});
