// @effect-diagnostics nodeBuiltinImport:off
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

// Returns true if `cwd` is inside a git working tree, walking up ancestors to
// find the enclosing repository (matches `git rev-parse`'s behaviour). A bare
// `existsSync(join(cwd, ".git"))` only matched when cwd was the repo root, so a
// workspace nested in a subdirectory was treated as non-git — suppressing
// checkpoint capture, completion events, and rewind for those workspaces.
export function isGitRepository(cwd: string): boolean {
  let current = cwd;
  for (;;) {
    if (existsSync(join(current, ".git"))) {
      return true;
    }
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}
