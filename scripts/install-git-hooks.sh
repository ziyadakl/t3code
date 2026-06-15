#!/usr/bin/env bash
#
# Idempotent installer for the repo's tracked git hooks. Points git at .githooks/
# (which holds post-commit auto-deploy) and makes the hooks executable.
# Safe to run repeatedly; runs automatically via the root `prepare` script.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Only meaningful inside a git work tree.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "(not a git repo; skipping hook install)"; exit 0; }

git config core.hooksPath .githooks
chmod +x .githooks/* 2>/dev/null || true

echo "git hooks installed: core.hooksPath -> .githooks (auto-deploy on commit)."
echo "  toggle off: pnpm run deploy:auto:off   |   on: pnpm run deploy:auto:on"
