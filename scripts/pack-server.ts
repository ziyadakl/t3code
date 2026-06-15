#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off -- procedural build script (not an Effect runtime); mirrors scripts/release-smoke.ts
/**
 * Build a self-installable npm tarball of the `t3` server package from this
 * fork, with `catalog:` dependencies resolved to concrete versions.
 *
 * This mirrors the dependency resolution that `apps/server/scripts/cli.ts
 * publish` performs, but produces a local `.tgz` via `npm pack` instead of
 * publishing to npm — so the fork's own server build can be deployed to a VPS.
 *
 * Prereq: build the server first so the assets exist:
 *   pnpm exec vp run --filter @t3tools/web build
 *   pnpm exec vp run --filter t3 build
 *
 * Output: `apps/server/t3-<version>.tgz`. Install it on the target with:
 *   npm install --prefix <dir> apps/server/t3-<version>.tgz
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = join(repoRoot, "apps/server");
const pkgPath = join(serverDir, "package.json");
const backupPath = `${pkgPath}.pack-bak`;

for (const rel of ["dist/bin.mjs", "dist/client/index.html"]) {
  if (!existsSync(join(serverDir, rel))) {
    throw new Error(
      `Missing build asset: apps/server/${rel}. Run \`pnpm exec vp run --filter t3 build\` first.`,
    );
  }
}

const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const serverPkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const catalog: Record<string, string> = rootPkg.workspaces.catalog;

const resolved = {
  name: serverPkg.name,
  repository: serverPkg.repository,
  bin: serverPkg.bin,
  type: serverPkg.type,
  version: serverPkg.version,
  engines: serverPkg.engines,
  files: serverPkg.files,
  dependencies: resolveCatalogDependencies(serverPkg.dependencies, catalog, "apps/server"),
  overrides: resolveCatalogDependencies(rootPkg.overrides ?? {}, catalog, "apps/server"),
};

const original = readFileSync(pkgPath, "utf8");
writeFileSync(backupPath, original);
try {
  writeFileSync(pkgPath, `${JSON.stringify(resolved, null, 2)}\n`);
  process.stdout.write(`[pack-server] Resolved package.json for t3@${resolved.version}; running npm pack…\n`);
  execFileSync("npm", ["pack"], { cwd: serverDir, stdio: "inherit" });
  process.stdout.write(`[pack-server] Done → apps/server/t3-${resolved.version}.tgz\n`);
} finally {
  // Always restore the original (catalog:-based) package.json.
  renameSync(backupPath, pkgPath);
}
