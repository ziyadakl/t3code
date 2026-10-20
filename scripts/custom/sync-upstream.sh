#!/usr/bin/env bash
# Bring the official T3 Code (upstream/main) into our fork branch custom-v2.
# Run on affinity-vps from the fork checkout. It never pushes and never deploys.
# CUSTOM.md lists every feature that is ours and the rule for dropping it.
#
#   scripts/custom/sync-upstream.sh start   merge upstream/main into a new sync branch
#   scripts/custom/sync-upstream.sh check   run CI's lint, typecheck and unused-code checks, build
#                                           the web app (React Compiler on), run the test files the sync
#                                           touched, and fail on release links that name the fork
set -euo pipefail

repo="$(git rev-parse --path-format=absolute --git-common-dir)/.."
repo="$(cd "$repo" && pwd)"
worktree="$(dirname "$repo")/wt-sync"
upstream_url="https://github.com/pingdotgg/t3code.git"

indent() { sed 's/^/  /'; }

# owner/name of a GitHub remote URL (https or ssh).
fork_slug() { sed -E 's#^.*github\.com[:/]##; s#\.git$##' <<<"$1"; }

# Test files the sync added or changed since <base>, one path per line. Deleted files are skipped.
touched_test_files() {
  git diff --name-only --diff-filter=ACMR "$1" HEAD -- |
    grep -E '\.(test|spec)\.[cm]?[jt]sx?$' || true
}

# Lists built files under <dist> that name <slug>; returns 1 when there are any. A fork has no
# releases, so a "what's new" link baked into the build must name upstream.
fork_link_hits() {
  local hits
  hits="$(grep -rlF --include='*.js' --include='*.html' --include='*.mjs' -- "$2" "$1" 2>/dev/null || true)"
  [ -z "$hits" ] && return 0
  echo "$hits"
  return 1
}

# Runs the touched test files of one workspace package through that package's own `test` script
# (its projects and config), narrowed to the files. $1 = package dir (apps/web), the rest = test
# paths relative to the repo root.
run_touched_tests() {
  local dir="$1" files=() f
  shift
  for f in "$@"; do files+=("${f#"$dir"/}"); done
  (cd "$dir" && pnpm run test "${files[@]}")
}

# Production web build, as the fork's CI and release builds run it: the web app's own `build`
# script (vite, React Compiler on), with GITHUB_REPOSITORY naming the fork and the release
# workflow's T3CODE_DESKTOP_UPDATE_REPOSITORY. Fails when the compiler skips a component (it only
# warns by default) or when a built file names the fork.
web_build_and_links() {
  local slug update_repo workflow=.github/workflows/custom-mac-build.yml
  local cfg=apps/web/vite.config.ts probe=apps/web/vite.compiler-check.config.ts log
  slug="$(fork_slug "$(git remote get-url origin)")"
  update_repo="$(sed -nE 's/^[[:space:]]*T3CODE_DESKTOP_UPDATE_REPOSITORY:[[:space:]]*([^[:space:]#]+).*$/\1/p' "$workflow" | head -1)"
  echo "> web build (React Compiler on, skipped components reported), GITHUB_REPOSITORY=$slug T3CODE_DESKTOP_UPDATE_REPOSITORY=${update_repo:-<unset>}"

  # A copy of the web config that makes the compiler report what it skips. The real config stays untouched.
  sed 's/react({ compiler: true })/react({ compiler: { reportDiagnostics: true } })/' "$cfg" >"$probe"
  if cmp -s "$cfg" "$probe"; then
    rm -f "$probe"
    echo "$cfg no longer has react({ compiler: true }). Update web_build_and_links in $0 to match it." >&2
    return 1
  fi
  log="$(mktemp)"
  rm -rf apps/web/dist
  local status=0
  (cd apps/web && GITHUB_REPOSITORY="$slug" T3CODE_DESKTOP_UPDATE_REPOSITORY="$update_repo" \
    pnpm exec vp build --config "$(basename "$probe")") >"$log" 2>&1 || status=$?
  rm -f "$probe"
  if [ "$status" -ne 0 ]; then
    tail -40 "$log" >&2
    rm -f "$log"
    echo "The web build failed." >&2
    return 1
  fi
  if grep -q '^\[plugin vite:react-compiler\]' "$log"; then
    sed -n '/^\[plugin vite:react-compiler\]/,/note: React Compiler skipped/p' "$log" >&2
    rm -f "$log"
    echo "React Compiler skipped the components above. CI rejects them; rewrite the code the compiler names." >&2
    return 1
  fi
  rm -f "$log"

  echo "> release links in the web build"
  local hits
  if ! hits="$(fork_link_hits apps/web/dist "$slug")"; then
    echo "These built files name $slug, which has no releases. Set T3CODE_DESKTOP_UPDATE_REPOSITORY to pingdotgg/t3code in $workflow:" >&2
    indent <<<"$hits" >&2
    return 1
  fi
}

# Test files the sync touched (against the pre-sync custom-v2), run package by package.
# SYNC_BASE overrides the base commit, to check a sync whose pull request already merged.
touched_tests() {
  local base files pkgs pkg failed=()
  base="${SYNC_BASE:-$(git merge-base HEAD origin/custom-v2)}"
  files="$(touched_test_files "$base")"
  if [ "$(uname)" = Darwin ]; then
    # Files named *Linux* test Linux-only behaviour (the Mac's file system ignores case, so they fail here).
    files="$(grep -v 'Linux[^/]*$' <<<"$files" || true)"
  fi
  if [ -z "$files" ]; then
    echo "> touched tests: none"
    return 0
  fi
  # macOS temp dirs sit behind a symlink (/var -> /private/var); tests that compare a temp path
  # with its real path fail there and pass on Linux CI. Hand them the real path.
  TMPDIR="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
  export TMPDIR
  # The package is the first two path segments (apps/web); files elsewhere run from the repo root.
  pkgs="$(awk -F/ '{ if ($1 == "apps" || $1 == "packages" || $1 == "infra") print $1 "/" $2; else print "." }' <<<"$files" | sort -u)"
  for pkg in $pkgs; do
    echo "> touched tests in $pkg"
    if [ "$pkg" = . ]; then
      # shellcheck disable=SC2046 # one path per line, none with spaces
      pnpm exec vp test run --passWithNoTests $(grep -vE '^(apps|packages|infra)/' <<<"$files") || failed+=("$pkg")
    elif [ -f "$pkg/package.json" ]; then
      # shellcheck disable=SC2046
      run_touched_tests "$pkg" $(grep "^$pkg/" <<<"$files") || failed+=("$pkg")
    fi
  done
  if [ "${#failed[@]}" -gt 0 ]; then
    echo "Touched tests failed in: ${failed[*]}" >&2
    return 1
  fi
}

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

  # CI runs the Node that package.json asks for; other versions fail tests that pass in CI
  # (for example `node:sea` is unknown to Vite on Node 22).
  local want have
  want="$(node -p "require('./package.json').engines.node.match(/\\d+/)[0]")"
  have="$(node -p "process.versions.node.split('.')[0]")"
  if [ "$want" != "$have" ]; then
    echo "package.json asks for Node $want but this shell runs Node $(node -v). Switch first (fnm use $want), then run this again." >&2
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

  web_build_and_links
  touched_tests

  local branch
  branch="$(git rev-parse --abbrev-ref HEAD)"
  echo
  echo "Lint, typecheck, unused-code, web build, touched-test and release-link checks passed on $branch."
  echo "The full tests run in CI on the pull request; CI must be green before merging."
  echo "Next: git push -u origin $branch, open a pull request into custom-v2, merge it when green."
  echo "GitHub then builds the new version. Install it everywhere with t3-switch-build.sh on the Mac."
  echo "Afterwards clean up:"
  echo "  git worktree remove $worktree"
  echo "  git branch -D $branch"
  echo "  git push origin --delete $branch   # unless GitHub already deleted it on merge"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    start) start ;;
    check) check ;;
    *) echo "usage: $0 start|check" >&2; exit 64 ;;
  esac
fi
