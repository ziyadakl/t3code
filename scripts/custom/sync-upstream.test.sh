#!/usr/bin/env bash
# Tests for the pure helpers behind `sync-upstream.sh check`. Run: bash scripts/custom/sync-upstream.test.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/custom/sync-upstream.sh
# shellcheck disable=SC1091 # the path is resolved at run time
source "$here/sync-upstream.sh"
set +e

fails=0
expect() { # expect <name> <expected> <actual>
  if [ "$2" = "$3" ]; then
    echo "ok   $1"
  else
    echo "FAIL $1"
    echo "  expected: $2"
    echo "  actual:   $3"
    fails=$((fails + 1))
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# --- touched_test_files: the test files a sync added or changed, not deleted ones ---
git init -q "$tmp/repo"
(
  cd "$tmp/repo"
  git config user.email t@t && git config user.name t
  mkdir -p dir
  echo 1 >a.test.ts
  echo 1 >b.ts
  echo 1 >e.test.ts
  echo 1 >keep.test.ts
  git add -A && git commit -qm base
  git branch -M main
  git checkout -qb sync
  echo 2 >a.test.ts
  echo 1 >c.test.tsx
  echo 1 >d.ts
  echo 1 >dir/f.spec.js
  echo 1 >g.browser.test.tsx
  git rm -q e.test.ts
  git add -A && git commit -qm sync
)
got="$(cd "$tmp/repo" && touched_test_files main | tr '\n' ' ')"
expect "touched_test_files lists added and changed test files only" \
  "a.test.ts c.test.tsx dir/f.spec.js g.browser.test.tsx " "$got"

# --- fork_slug: owner/name of origin, for https and ssh remotes ---
expect "fork_slug from an https remote" "ziyadakl/t3code" "$(fork_slug https://github.com/ziyadakl/t3code.git)"
expect "fork_slug from an ssh remote" "ziyadakl/t3code" "$(fork_slug git@github.com:ziyadakl/t3code.git)"

# --- fork_link_hits: built files that still name the fork ---
mkdir -p "$tmp/dist/assets"
echo 'const u="https://github.com/pingdotgg/t3code/releases/tag/v1";' >"$tmp/dist/assets/clean.js"
fork_link_hits "$tmp/dist" ziyadakl/t3code >"$tmp/out"
expect "fork_link_hits passes a build that names upstream" "0" "$?"
echo 'const r="ziyadakl/t3code";' >"$tmp/dist/assets/bad.js"
fork_link_hits "$tmp/dist" ziyadakl/t3code >"$tmp/out"
expect "fork_link_hits fails a build that names the fork" "1" "$?"
expect "fork_link_hits names the file" "assets/bad.js" "$(sed 's|^.*dist/||' "$tmp/out" | head -1)"

if [ "$fails" -eq 0 ]; then echo "all passed"; else echo "$fails failed"; exit 1; fi
