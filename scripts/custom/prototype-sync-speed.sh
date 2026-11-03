#!/usr/bin/env bash
# PROTOTYPE, throwaway: never merge. Lives on branch proto/sync-speed only.
#
# Question: which sync pipeline gets from upstream/main to a green, mergeable custom-v2 in the
# least wall-clock time, with today's safety? This script times every local step of a sync on
# affinity-vps and prints one table. CI-side candidates are timed by this branch's ci.yml.
#
#   scripts/custom/prototype-sync-speed.sh [phase...]   default: all phases in order
#   phases: setup install checks server web merge warm
#
# Logs: $PROTO_LOG (default /tmp/proto-sync-speed), one file per step plus summary.txt.
set -uo pipefail

export PATH="$HOME/.local/share/fnm/node-versions/v26.12.1/installation/bin:$PATH"
repo="$HOME/dev/2-personal/t3code/t3code"
wt="$HOME/dev/2-personal/t3code/wt-proto-measure"
log="${PROTO_LOG:-/tmp/proto-sync-speed}"
mkdir -p "$log"
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=gc.auto GIT_CONFIG_VALUE_0=0

# step <name> <command...>: run it, log its output, print its wall time and exit code.
step() {
  local name="$1" s e rc
  shift
  s=$(date +%s%3N)
  ("$@") >"$log/$name.log" 2>&1
  rc=$?
  e=$(date +%s%3N)
  printf '%-36s %6d.%01ds  exit=%s\n' "$name" $(((e - s) / 1000)) $(((e - s) % 1000 / 100)) "$rc" | tee -a "$log/summary.txt"
}

px() { pnpm exec "$@"; }

phase_setup() {
  cd "$repo" || exit 1
  step fetch bash -c 'git fetch -q upstream main:refs/remotes/upstream/main && git fetch -q origin custom-v2'
  if [ -e "$wt" ]; then git worktree remove --force "$wt"; fi
  step worktree-add git worktree add --detach "$wt" origin/custom-v2
}

phase_install() {
  cd "$wt" || exit 1
  step install-cold-node_modules pnpm install --frozen-lockfile
  step install-noop pnpm install --frozen-lockfile
}

phase_checks() {
  cd "$wt" || exit 1
  step ensure-electron px vp run --filter @t3tools/desktop ensure:electron
  step knip px vp run knip:check
  step vp-check px vp check
  step typecheck-cold px vpr typecheck
  step typecheck-rerun-cached px vpr typecheck
  step web-build bash -c 'cd apps/web && pnpm run build'
  # The same four checks side by side, as a 12-CPU box could run them.
  step checks-all-parallel bash -c '
    pnpm exec vp run knip:check > /dev/null 2>&1 & a=$!
    pnpm exec vp check > /dev/null 2>&1 & b=$!
    pnpm exec vpr typecheck > /dev/null 2>&1 & c=$!
    (cd apps/web && pnpm run build) > /dev/null 2>&1 & d=$!
    rc=0; for p in $a $b $c $d; do wait $p || rc=1; done; exit $rc'
}

phase_server() {
  cd "$wt" || exit 1
  # Same shard, same files (both use WeightedShardSequencer): one test runner per file, as CI
  # runs it today, against one runner for the whole shard.
  step server-shard3of8-test-cached px vp run test:cached -- --shard 3/8 apps/server
  step server-shard3of8-one-runner bash -c 'cd apps/server && pnpm exec vp test run --shard 3/8'
}

phase_web() {
  cd "$wt" || exit 1
  # 4 CPUs approximates a GitHub runner; 12 is the whole box (a self-hosted runner).
  step web-tests-shard1of4-on-4cpu taskset -c 0-3 bash -c "cd apps/web && pnpm exec vp test run --passWithNoTests --project unit --project browser --shard 1/4 --exclude '**/AttachmentFilePreview.browser.test.tsx'"
  step web-tests-all-on-12cpu bash -c "cd apps/web && pnpm exec vp test run --passWithNoTests --project unit --project browser --exclude '**/AttachmentFilePreview.browser.test.tsx'"
}

phase_merge() {
  cd "$wt" || exit 1
  git checkout -q --detach origin/custom-v2
  git config rerere.enabled true
  step merge-upstream bash -c 'git merge --no-ff --no-commit upstream/main; exit 0'
  {
    echo "behind: $(git rev-list --count origin/custom-v2..upstream/main) commits"
    echo "conflicted files:"; git diff --name-only --diff-filter=U | sed 's/^/  /'
    echo "conflict hunks: $(git diff --diff-filter=U | grep -c '^[+ ]*<<<<<<<')"
    echo "left after rerere replay:"; git rerere remaining | sed 's/^/  /'
  } | tee "$log/merge-conflicts.txt"
  git merge --abort
}

phase_warm() {
  cd "$wt" || exit 1
  # A worktree kept from the last sync: move it to the new Upstream tree and pay only the change.
  git checkout -q --detach upstream/main
  step install-warm-after-121-commits pnpm install --frozen-lockfile
  step typecheck-warm-after-121-commits px vpr typecheck
  git checkout -q --detach origin/custom-v2
}

phases=("$@")
[ ${#phases[@]} -eq 0 ] && phases=(setup install checks server web merge warm)
echo "== prototype-sync-speed $(date -u +%FT%TZ) on $(hostname), $(nproc) CPUs, node $(node -v)" | tee -a "$log/summary.txt"
for p in "${phases[@]}"; do "phase_$p"; done
echo "== done $(date -u +%FT%TZ)" | tee -a "$log/summary.txt"
