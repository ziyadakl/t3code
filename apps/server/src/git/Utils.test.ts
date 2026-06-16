// @effect-diagnostics nodeBuiltinImport:off - exercises real filesystem layout to verify git-root detection.
import { assert, describe, it } from "@effect/vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isGitRepository } from "./Utils.ts";

describe("isGitRepository", () => {
  it("returns true when .git is directly in the directory", () => {
    const root = mkdtempSync(join(tmpdir(), "git-utils-"));
    try {
      mkdirSync(join(root, ".git"));
      assert.equal(isGitRepository(root), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns true for a directory nested inside a git repository", () => {
    const root = mkdtempSync(join(tmpdir(), "git-utils-"));
    try {
      mkdirSync(join(root, ".git"));
      const nested = join(root, "apps", "server");
      mkdirSync(nested, { recursive: true });
      assert.equal(isGitRepository(nested), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns false when no .git exists in the directory or any ancestor", () => {
    const root = mkdtempSync(join(tmpdir(), "git-utils-"));
    try {
      const nested = join(root, "nope");
      mkdirSync(nested, { recursive: true });
      assert.equal(isGitRepository(nested), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
