#!/usr/bin/env bash
# Bring the official T3 Code (upstream/main) into our fork branch custom-v2.
# Run on affinity-vps from the fork checkout. It never pushes and never deploys.
# CUSTOM.md lists every feature that is ours and the rule for dropping it.
#
#   scripts/custom/sync-upstream.sh start   merge upstream/main into a new sync branch
#   scripts/custom/sync-upstream.sh check   run CI's lint, typecheck and unused-code checks
set -euo pipefail

repo="$(git rev-parse --path-format=absolute --git-common-dir)/.."
repo="$(cd "$repo" && pwd)"
worktree="$(dirname "$repo")/wt-sync"
upstream_url="https://github.com/pingdotgg/t3code.git"

indent() { sed 's/^/  /'; }

start() {
  cd "$repo"
  if ! git remote get-url upstream >/dev/null 2>&1; then
    echo "No upstream remote. Add it, then run this again:" >&2
    echo "  git remote add upstream $upstream_url" >&2
    return 1
  fi
  git fetch --quiet upstream
  git fetch --quiet origin

  # Remember every conflict fix so a redone sync replays it. Replayed fixes stay
  # unstaged (no autoupdate) so they get reviewed; keep the records for a year.
  git config rerere.enabled true
  git config rerere.autoupdate false
  git config gc.rerereResolved 365

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
  local branch
  branch="sync/upstream-$(date +%Y-%m-%d)"
  if git show-ref --quiet --verify "refs/heads/$branch"; then
    echo "Branch $branch already exists from an earlier sync today." >&2
    echo "If its pull request merged, delete it: git branch -D $branch" >&2
    return 1
  fi
  git worktree add --quiet "$worktree" -b "$branch" origin/custom-v2
  cd "$worktree"

  local sha
  sha="$(git rev-parse --short upstream/main)"
  if ! git merge --no-ff --no-edit -m "chore(sync): merge upstream/main $sha into custom-v2" upstream/main; then
    local unmerged remaining replayed
    unmerged="$(git diff --name-only --diff-filter=U)"
    remaining="$(git rerere remaining)"
    replayed="$(comm -23 <(sort <<<"$unmerged") <(sort <<<"$remaining"))"
    echo
    if [ -n "$replayed" ]; then
      echo "Resolved from an earlier fix (review each, then git add it):"
      indent <<<"$replayed"
    fi
    if [ -n "$remaining" ]; then
      echo "Conflicts remain in:"
      indent <<<"$remaining"
    fi
    echo
    echo "Resolve them in $worktree as CUSTOM.md says, then run:"
    echo "  git add <files> && git commit --no-edit && $0 check"
    return 2
  fi
  check
}

check() {
  cd "$worktree"
  if git rev-parse --quiet --verify MERGE_HEAD >/dev/null; then
    echo "The merge in $worktree is not committed yet. Finish it: git commit --no-edit" >&2
    return 1
  fi
  if git grep -n -E '^(<<<<<<< |>>>>>>> )' -- .; then
    echo "Conflict markers remain in the lines above. Resolve them and amend the merge." >&2
    return 1
  fi

  # The same commands as the Lint and Typecheck jobs in .github/workflows/ci.yml.
  # Mobile native lint skips tools this machine lacks (swiftlint, ktlint, detekt).
  local ci=.github/workflows/ci.yml cmd
  local cmds=(
    "vp run --filter @t3tools/desktop ensure:electron"
    "vp run knip:check"
    "vp check"
    "vpr typecheck"
    "vp run lint:mobile"
  )
  for cmd in "${cmds[@]}"; do
    # A command may sit on its own "run:" line or inside a multi-line run block.
    if ! grep -qE "^[[:space:]]*(- )?(run: )?${cmd}[[:space:]]*\$" "$ci"; then
      echo "$ci no longer runs '$cmd'. Update the list in $0 to match it." >&2
      return 1
    fi
  done

  pnpm install --frozen-lockfile
  for cmd in "${cmds[@]}"; do
    echo "> $cmd"
    # shellcheck disable=SC2086 # each entry is a command line to split
    pnpm exec $cmd
  done

  local branch
  branch="$(git rev-parse --abbrev-ref HEAD)"
  echo
  echo "Lint, typecheck and unused-code checks passed on $branch."
  echo "The full tests run in CI on the pull request; CI must be green before merging."
  echo "Next: git push -u origin $branch, open a pull request into custom-v2, merge it when green."
  echo "GitHub then builds the new version. Install it everywhere with t3-switch-build.sh on the Mac."
  echo "Afterwards clean up:"
  echo "  git worktree remove $worktree"
  echo "  git branch -D $branch"
  echo "  git push origin --delete $branch   # unless GitHub already deleted it on merge"
}

case "${1:-}" in
  start) start ;;
  check) check ;;
  *) echo "usage: $0 start|check" >&2; exit 64 ;;
esac
