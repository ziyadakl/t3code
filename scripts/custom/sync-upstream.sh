#!/usr/bin/env bash
# Bring the official T3 Code (upstream/main) into our fork branch custom-v2.
# Run on affinity-vps from the fork checkout. It never pushes and never deploys.
# CUSTOM.md lists every feature that is ours and the rule for dropping it.
#
#   scripts/custom/sync-upstream.sh start   merge upstream/main into a new sync branch
#   scripts/custom/sync-upstream.sh check   run CI's lint, typecheck and unused-code checks side by
#                                           side, build the web app (React Compiler on), and fail on
#                                           release links that name the fork or on fork-edited native
#                                           mobile files; about 40 seconds. CI runs every test. It
#                                           starts by printing the footprint before and after
#   scripts/custom/sync-upstream.sh footprint [ref]   print how many Upstream files <ref> (default
#                                           HEAD) edits against upstream/main, and the lines changed
set -euo pipefail

repo="$(git rev-parse --path-format=absolute --git-common-dir)/.."
repo="$(cd "$repo" && pwd)"
worktree="$(dirname "$repo")/wt-sync"
upstream_url="https://github.com/pingdotgg/t3code.git"

scratch_probe=
scratch_log=
indent() { sed 's/^/  /'; }

# owner/name of a GitHub remote URL (https or ssh).
fork_slug() { sed -E 's#^.*github\.com[:/]##; s#\.git$##' <<<"$1"; }

# The native mobile paths of MOBILE_NATIVE in .github/scripts/ci-changes.cjs, the files the macOS
# lint checks; the rest of that rule is the files that configure the lint itself.
native_pattern='^apps/mobile/.*\.(swift|kt|kts)$|^apps/mobile/(\.swiftlint\.yml|detekt\.yml|\.editorconfig|Brewfile)$|^scripts/mobile-native-static-check\.ts$'
native_rest='|^package\.json$|^\.github/workflows/ci\.yml$|^\.github/scripts/ci-changes\.cjs$|^\.github/actions/ci-changes/'

# True while MOBILE_NATIVE in <ci-changes.cjs> is exactly native_pattern plus native_rest, so a
# change Upstream makes to it fails the check instead of leaving native_pattern stale.
native_rule_matches() { # native_rule_matches <ci-changes.cjs>
  local js
  js="$(sed -n '/^const MOBILE_NATIVE =$/{n;p;}' "$1" | sed -E 's#^[[:space:]]*/##; s#/;[[:space:]]*$##; s#\\/#/#g')"
  [ "$js" = "$native_pattern$native_rest" ]
}

# Native mobile files the fork edits or adds against <upstream-ref>, one per line. CI skips the
# macOS lint on sync/upstream-* branches (ci.yml, changes job): a sync's native changes are then
# Upstream's own, already linted by Upstream. That holds only while this list is empty.
fork_native_files() { # fork_native_files <upstream-ref> <fork-ref>
  local base changed
  # Capture git's output first: inside a pipe its failure (a bad ref) would read as "no files".
  base="$(git merge-base "$1" "$2")" || return $?
  changed="$(git diff --name-only --no-renames --diff-filter=AM "$base" "$2" --)" || return $?
  grep -E "$native_pattern" <<<"$changed" || true
}

# Runs each command line at once, each into its own log. Prints every result with its time, and
# the last 40 lines of each failure. Returns 1 when any failed, and then keeps the logs.
run_parallel() { # run_parallel <command line>...
  local dir i=0 cmd rc secs status=0
  dir="$(mktemp -d)"
  for cmd in "$@"; do
    (
      s=$SECONDS
      # In an if, so set -e cannot stop this shell before the status is written; in its own
      # shell, so a command that calls exit cannot either.
      if (eval "$cmd") >"$dir/$i.log" 2>&1; then rc=0; else rc=$?; fi
      echo "$rc $((SECONDS - s))" >"$dir/$i.rc"
    ) &
    i=$((i + 1))
  done
  wait
  i=0
  for cmd in "$@"; do
    # No status file means the command never finished: count it as failed.
    rc=1 secs="?"
    [ -f "$dir/$i.rc" ] && read -r rc secs <"$dir/$i.rc"
    if [ "$rc" -eq 0 ]; then
      echo "> $cmd: passed in ${secs}s"
    else
      echo "> $cmd: FAILED (exit $rc) after ${secs}s" >&2
      tail -40 "$dir/$i.log" | indent >&2
      status=1
    fi
    i=$((i + 1))
  done
  if [ "$status" -eq 0 ]; then
    rm -rf "$dir"
  else
    echo "Full logs: $dir" >&2
  fi
  return "$status"
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

# Upstream files the fork edits: files present where <fork> last met <upstream> that differ on <fork>
# (modified or deleted; a rename counts as a deletion plus a new file), and the lines changed in them.
footprint() { # footprint <upstream-ref> <fork-ref> -> "<n> files, +<a> -<d> lines"
  local base stat
  # Capture git's output first: inside a pipe its failure (a bad ref) would read as "0 files".
  base="$(git merge-base "$1" "$2")" || return $?
  stat="$(git diff --no-renames --numstat --diff-filter=MD "$base" "$2" --)" || return $?
  # NF skips the empty line an empty here-string still yields; "-" columns are binary files.
  awk 'NF { n++; if ($1 != "-") a += $1; if ($2 != "-") d += $2 }
       END { printf "%d files, +%d -%d lines\n", n, a, d }' <<<"$stat"
}

# Production web build, as the fork's CI and release builds run it: the web app's own `build`
# script (vite, React Compiler on), with GITHUB_REPOSITORY naming the fork and the release
# workflow's T3CODE_DESKTOP_UPDATE_REPOSITORY. Fails when the compiler skips a component (it only
# warns by default) or when a built file names the fork.
web_build_and_links() {
  local slug update_repo workflow=.github/workflows/custom-mac-build.yml
  local cfg=apps/web/vite.config.ts probe=apps/web/vite.compiler-check.config.ts log
  # The probe config and the log are scratch: remove them on exit or interrupt. Globals, because
  # the trap runs after this function's locals are gone.
  scratch_probe="$probe"
  scratch_log=
  trap 'rm -f "$scratch_probe" "$scratch_log"' EXIT
  trap 'exit 130' INT TERM
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
  scratch_log="$log"
  rm -rf apps/web/dist
  local status=0
  (cd apps/web && NO_COLOR=1 GITHUB_REPOSITORY="$slug" T3CODE_DESKTOP_UPDATE_REPOSITORY="$update_repo" \
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

  # Printed first, so a failing check still shows it.
  local before_ref
  before_ref="${SYNC_BASE:-$(git merge-base HEAD origin/custom-v2)}"
  echo "> footprint (Upstream files the fork edits): before $(footprint upstream/main "$before_ref"), after $(footprint upstream/main HEAD)"

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
  # Mobile native lint is skipped when this machine lacks ktlint or detekt, and skips SwiftLint when missing.
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

  local native rules=.github/scripts/ci-changes.cjs
  if ! native_rule_matches "$rules"; then
    echo "MOBILE_NATIVE in $rules changed. Update native_pattern and native_rest in $0 to match it." >&2
    return 1
  fi
  native="$(fork_native_files upstream/main HEAD)" || return $?
  if [ -n "$native" ]; then
    echo "The fork edits these native mobile files, but CI skips the macOS lint on sync branches:" >&2
    indent <<<"$native" >&2
    echo "Remove the sync/upstream-* skip from mobile_native in $ci (changes job) first." >&2
    return 1
  fi

  pnpm install --frozen-lockfile
  # Electron's runtime first, as the Lint job installs it before knip; the rest side by side.
  echo "> ${cmds[0]}"
  # shellcheck disable=SC2086 # a command line to split
  pnpm exec ${cmds[0]}
  local parallel=()
  for cmd in "${cmds[@]:1}"; do
    # Upstream's mobile lint now fails when ktlint or detekt is missing; CI has them, this machine may not.
    if [ "$cmd" = "vp run lint:mobile" ] && ! { command -v ktlint >/dev/null && command -v detekt >/dev/null; }; then
      echo "> $cmd skipped: ktlint or detekt is not installed here. CI runs it on the pull request."
      continue
    fi
    parallel+=("pnpm exec $cmd")
  done
  run_parallel "${parallel[@]}" || return 1
  # After the others: its probe config file would show up in knip and vp check.
  web_build_and_links

  local branch
  branch="$(git rev-parse --abbrev-ref HEAD)"
  echo
  echo "Lint, typecheck, unused-code, web build, release-link and native-file checks passed on $branch."
  echo "Every test runs in CI on the pull request; CI must be green before merging."
  echo "Next: git push -u origin $branch (GitHub starts the Mac and Linux builds at once),"
  echo "open a pull request into custom-v2, and when CI is green merge it by fast-forward:"
  echo "  git push origin $branch:custom-v2"
  echo "The commit stays the same, so the build already made is the new version, and GitHub marks"
  echo "the pull request merged. If the push is refused, custom-v2 moved: merge origin/custom-v2 into"
  echo "$branch, push, and wait for CI again. Install the build with t3-switch-build.sh on the Mac."
  echo "Afterwards clean up:"
  echo "  git worktree remove $worktree"
  echo "  git branch -D $branch"
  echo "  git push origin --delete $branch   # unless GitHub already deleted it on merge"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    start) start ;;
    check) check ;;
    footprint) footprint upstream/main "${2:-HEAD}" ;;
    *) echo "usage: $0 start|check|footprint [ref]" >&2; exit 64 ;;
  esac
fi
