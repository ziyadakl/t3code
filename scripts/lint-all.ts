#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off -- procedural lint orchestrator (not an Effect runtime); mirrors scripts/pack-server.ts
/**
 * Lint the WHOLE repo green WITHOUT running out of memory.
 *
 * The root `vp lint` ran the linter as ONE monolithic whole-repo pass, which
 * OOMs (JS heap exhaustion / worker termination) on this monorepo. The fix is
 * to lint each top-level area as a SEPARATE sequential `vp lint` child process:
 * each process frees its working set on exit, so peak memory stays bounded.
 *
 * Coverage parity with the old monolithic pass is preserved:
 *   - the per-app dirs under apps/ (desktop, marketing, mobile, server, web),
 *   - the other top-level lintable dirs (`packages`, `infra`,
 *     `oxlint-plugin-t3code`, `scripts`), plus
 *   - the root-level config source files (currently just `vite.config.ts`).
 * Together these lint exactly the same file set the monolithic pass did
 * (verified: 1472 files = 1173 (apps/*) + 205 packages + 54 infra + 7
 * oxlint-plugin-t3code + 32 scripts + 1 vite.config.ts).
 * The global lint config (rules, the custom `oxlint-plugin-t3code` plugin, and
 * `ignorePatterns`) lives in `vite.config.ts` and applies regardless of which
 * path is passed, so each per-target pass uses the same rules as before.
 *
 * stdio: each `vp lint` child's output is captured (NOT `stdio: "inherit"`)
 * and re-emitted through this process's own stdout/stderr. When this script is
 * launched via `pnpm run`, the inherited stdout is pnpm's wrapped reporter
 * pipe; oxlint's worker dies writing to it (surfacing the misleading
 * "Linter process terminated abnormally (possibly out of memory)"). Capturing
 * to a buffer and writing through our real stream avoids that entirely.
 *
 * Thread cap: oxlint defaults to one worker thread per CPU core. On a machine
 * under memory pressure, spawning ~10 workers on the largest target (`apps`,
 * 1000+ files) reliably crashes a worker — surfacing as "(possibly out of
 * memory)". Capping the worker pool keeps peak memory bounded and the gate
 * deterministic, mirroring the bounded concurrency used by `typecheck`
 * (`vp run -r --concurrency-limit 2`). Override via LINT_THREADS if needed.
 *
 * Every target runs even if an earlier one fails; the script exits 1 if ANY
 * target failed, else 0, and prints a per-target PASS/FAIL summary.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vpBin = resolve(repoRoot, "node_modules/.bin/vp");

const lintThreads = process.env.LINT_THREADS ?? "2";

// Lint targets, each run as its own `vp lint` process to bound peak memory.
// Directory targets cover their whole subtree recursively; the final entry
// covers root-level source files that live outside those dirs so we don't
// silently drop coverage the monolithic pass had.
const targets: ReadonlyArray<string> = [
  // `apps` is split per-app rather than linted as one `apps` pass: it is the
  // largest area (1000+ files) and linting it as a single process is what most
  // readily spikes memory / crashes an oxlint worker under host pressure.
  // Per-app processes keep each working set small. (Coverage is identical — the
  // five apps below are every directory under apps/.)
  "apps/desktop",
  "apps/marketing",
  "apps/mobile",
  "apps/server",
  "apps/web",
  "packages",
  "infra",
  "oxlint-plugin-t3code",
  "scripts",
  // Root-level lintable source files (parity with the monolithic root pass).
  // `vite.config.ts` is currently the only root-level *.ts/*.mts/*.cts/*.mjs
  // source file; pass it explicitly rather than walking the repo root
  // recursively (which would re-lint everything and re-introduce the OOM).
  "vite.config.ts",
];

interface TargetResult {
  readonly target: string;
  readonly status: number;
}

const results: Array<TargetResult> = [];

for (const target of targets) {
  process.stdout.write(`\n[lint-all] linting ${target}…\n`);

  // Capture (don't inherit) the child's stdio, then forward it through our
  // own real streams — see the file header for why `stdio: "inherit"` breaks
  // under `pnpm run`.
  const child = spawnSync(
    vpBin,
    ["lint", target, "--report-unused-disable-directives", `--threads=${lintThreads}`],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );

  if (child.stdout) {
    process.stdout.write(child.stdout);
  }
  if (child.stderr) {
    process.stderr.write(child.stderr);
  }

  if (child.error) {
    process.stderr.write(`[lint-all] failed to run vp lint for "${target}": ${child.error.message}\n`);
  }

  // A null status means the process was killed by a signal (e.g. OOM-kill);
  // treat that as a failure with a non-zero code so it is never reported PASS.
  const status = child.status ?? 1;
  if (child.signal !== null) {
    process.stderr.write(
      `[lint-all] target "${target}" terminated by signal ${child.signal}.\n`,
    );
  }
  results.push({ target, status });
}

process.stdout.write("\n[lint-all] summary:\n");
let failed = false;
for (const { target, status } of results) {
  const ok = status === 0;
  failed = failed || !ok;
  process.stdout.write(`  ${ok ? "PASS" : "FAIL"}  ${target}\n`);
}

process.exit(failed ? 1 : 0);
