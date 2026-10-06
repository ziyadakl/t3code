#!/usr/bin/env node
// This CLI parses its own arguments and reads the user's home at the application boundary.
// @effect-diagnostics nodeBuiltinImport:off

/**
 * Count what the resume picker would list for one project, without starting a
 * server or touching any T3 Code state. Reads only the Claude desktop app's
 * session cards and `~/.claude/projects`, and prints four numbers.
 *
 *   node apps/server/scripts/resume-picker-count.ts --project /path/to/project
 *
 * Override the sources for a fixture run with `--claude-home` and
 * `--desktop-store`.
 */
import * as NodeOS from "node:os";
import * as NodeUtil from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import * as ClaudeSessionSources from "../src/project/ClaudeSessionSources.ts";

const DESKTOP_STORE_DIR = ["Library", "Application Support", "Claude", "claude-code-sessions"];

const { values } = NodeUtil.parseArgs({
  options: {
    project: { type: "string" },
    "claude-home": { type: "string" },
    "desktop-store": { type: "string" },
  },
});

const program = Effect.gen(function* () {
  const path = yield* Path.Path;
  const projectRoot = values.project?.trim();
  if (!projectRoot) {
    yield* Console.error("Pass --project <absolute path to the T3 Code project>.");
    return 1;
  }
  const homeDir = NodeOS.homedir();

  // Listing with archived included gives every count in one pass.
  const sessions = yield* ClaudeSessionSources.listClaudeSessions({
    claudeHome: values["claude-home"]?.trim() || path.join(homeDir, ".claude"),
    desktopStoreDir: values["desktop-store"]?.trim() || path.join(homeDir, ...DESKTOP_STORE_DIR),
    workspaceRoot: path.resolve(projectRoot),
    includeArchived: true,
  });

  const desktop = sessions.filter((session) => session.origin === "desktop");
  const archived = sessions.filter((session) => session.archived);
  const cliOnly = sessions.filter((session) => session.origin === "cli");
  yield* Console.log(
    [
      `desktop sessions found: ${desktop.length}`,
      `archived hidden: ${archived.length}`,
      `cli-only: ${cliOnly.length}`,
      `total listed: ${sessions.length - archived.length}`,
    ].join("\n"),
  );
  return 0;
});

process.exitCode = await Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer)));
