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

# --- fork_native_files: native mobile files the fork edits or adds, not Upstream's own ---
git init -q "$tmp/nat"
(
  cd "$tmp/nat"
  git config user.email t@t && git config user.name t
  mkdir -p apps/mobile/ios apps/web
  echo 1 >apps/mobile/ios/App.swift
  echo 1 >apps/web/a.ts
  git add -A && git commit -qm base
  git branch -M main
  git checkout -qb upstream
  echo 2 >apps/mobile/ios/App.swift
  git add -A && git commit -qm "upstream edits its native file"
  git checkout -qb fork
  echo 2 >apps/web/a.ts
  git add -A && git commit -qm "fork edits web only"
  git branch fork-web
  echo 1 >apps/mobile/ios/Ours.swift
  echo 1 >apps/mobile/Brewfile
  git add -A && git commit -qm "fork adds native files"
)
expect "fork_native_files is empty when only Upstream edits native files" \
  "" "$(cd "$tmp/nat" && fork_native_files upstream fork-web)"
expect "fork_native_files lists the fork's own native files" \
  "apps/mobile/Brewfile apps/mobile/ios/Ours.swift " "$(cd "$tmp/nat" && fork_native_files upstream fork | tr '\n' ' ')"
(cd "$tmp/nat" && fork_native_files upstream no-such-ref >/dev/null 2>&1)
expect "fork_native_files fails on a bad ref instead of reporting none" "1" "$((($? != 0) ? 1 : 0))"

# --- run_parallel: every command runs, every result prints, any failure fails the whole ---
mkdir -p "$tmp/par"
out="$(run_parallel "$tmp/par" "sleep 1; echo one" "echo two; exit 3" "echo three" 2>&1)"
expect "run_parallel fails when one command fails" "1" "$?"
expect "run_parallel reports each command in order" \
  "> sleep 1; echo one: passed|> echo two; exit 3: FAILED (exit 3)|> echo three: passed" \
  "$(grep '^>' <<<"$out" | sed -E 's/ (in|after) [0-9]+s$//' | paste -sd'|' -)"
expect "run_parallel shows a failure's output" "1" "$(grep -c '^  two$' <<<"$out")"
s=$SECONDS
run_parallel "$tmp/par" "sleep 2" "sleep 2" "sleep 2" >/dev/null 2>&1
expect "run_parallel passes when all pass" "0" "$?"
expect "run_parallel runs the commands at the same time" "1" "$(((SECONDS - s) < 5 ? 1 : 0))"

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

# --- footprint: Upstream files the fork edits (modified or deleted), not the fork's new files ---
git init -q "$tmp/fp"
(
  cd "$tmp/fp"
  git config user.email t@t && git config user.name t
  printf 'a\nb\nc\n' >up1.ts
  printf 'x\ny\n' >up2.ts
  git add -A && git commit -qm base
  git branch -M main
  git checkout -qb upstream
  echo 1 >up3.ts
  git add -A && git commit -qm "upstream moves on"
  git checkout -qb fork main
  printf 'a\nB\nc\nd\n' >up1.ts
  git rm -q up2.ts
  echo 1 >fork.ts
  git add -A && git commit -qm fork
  git branch fork-edits
  git mv up1.ts moved.ts
  git commit -qm rename
)
expect "footprint counts modified and deleted Upstream files, not the fork's new ones" \
  "2 files, +2 -3 lines" "$(cd "$tmp/fp" && footprint upstream fork-edits)"
expect "footprint counts a rename as the deletion of the Upstream file" \
  "2 files, +0 -5 lines" "$(cd "$tmp/fp" && footprint upstream fork)"
expect "footprint is zero when the fork edits nothing" \
  "0 files, +0 -0 lines" "$(cd "$tmp/fp" && footprint upstream upstream)"
(cd "$tmp/fp" && footprint upstream no-such-ref >/dev/null 2>&1)
expect "footprint fails on a bad ref instead of reporting zero" "1" "$((($? != 0) ? 1 : 0))"

if [ "$fails" -eq 0 ]; then echo "all passed"; else echo "$fails failed"; exit 1; fi
