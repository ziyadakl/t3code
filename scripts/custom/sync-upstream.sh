#!/usr/bin/env bash
# Bring the official T3 Code (upstream/main) into our fork branch custom-v2.
# Run on affinity-vps from the fork checkout. It never pushes and never deploys.
# CUSTOM.md lists every feature that is ours and when to drop it.
#
#   scripts/custom/sync-upstream.sh start   merge upstream/main into a new sync branch
#   scripts/custom/sync-upstream.sh check   typecheck and lint the sync branch
set -euo pipefail

repo="$(git rev-parse --path-format=absolute --git-common-dir)/.."
repo="$(cd "$repo" && pwd)"
worktree="$(dirname "$repo")/wt-sync"

start() {
  cd "$repo"
  git fetch --quiet upstream
  git fetch --quiet origin

  # Remember every conflict fix, so the next sync replays it instead of asking again.
  git config rerere.enabled true
  git config rerere.autoupdate true

  local behind
  behind="$(git rev-list --count origin/custom-v2..upstream/main)"
  if [ "$behind" -eq 0 ]; then
    echo "custom-v2 already has everything in upstream/main. Nothing to do."
    return 0
  fi
  echo "upstream/main has $behind commits that custom-v2 lacks."

  if [ -e "$worktree" ]; then
    echo "A sync is already in progress at $worktree. Finish it or remove it first." >&2
    return 1
  fi
  git worktree add --quiet "$worktree" -b "sync/upstream-$(date +%Y-%m-%d)" origin/custom-v2
  cd "$worktree"

  if ! git merge --no-edit -m "Merge upstream/main ($(git rev-parse --short upstream/main)) into custom-v2" upstream/main; then
    echo
    echo "Conflicts remain in:"
    git diff --name-only --diff-filter=U | sed 's/^/  /'
    echo
    echo "Resolve them in $worktree. Upstream's code wins; then re-apply each feature in CUSTOM.md."
    echo "If upstream now does what a CUSTOM.md feature does, keep upstream's and delete that row."
    echo "Then run: git commit --no-edit && $0 check"
    return 2
  fi
  check
}

check() {
  cd "$worktree"
  pnpm install --frozen-lockfile
  pnpm run typecheck
  pnpm run lint
  pnpm run fmt:check
  pnpm run knip:check
  echo
  echo "Checks passed on $(git rev-parse --abbrev-ref HEAD)."
  echo "Next: push it, open a pull request into custom-v2, and merge when its checks are green."
  echo "GitHub then builds the new version. Install it everywhere with t3-switch-build.sh on the Mac."
  echo "Afterwards remove the sync copy: git worktree remove $worktree"
}

case "${1:-}" in
  start) start ;;
  check) check ;;
  *) echo "usage: $0 start|check" >&2; exit 64 ;;
esac
