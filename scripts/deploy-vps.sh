#!/usr/bin/env bash
#
# One-command deploy of the t3 fork server (server bundle + web client) to the VPS.
#
#   bun run deploy            # or: bash scripts/deploy-vps.sh
#
# Does the whole validated file-swap runbook with a hard stop on any failure, so
# it can never leave the live server half-swapped:
#   build web -> build server -> stage to VPS /tmp -> boot smoke-test on a scratch
#   port -> back up live files -> swap + chown -> restart the user service ->
#   verify HTTP on :4101.
#
# This is the FILE-SWAP path: it only ships dist/ (pure-JS) and restarts. It does
# NOT run `npm install` on the VPS, so if server dependencies changed it will
# refuse and tell you to use the tarball path instead.
#
# Overridable via env:
#   T3_DEPLOY_HOST   ssh target           (default: hub)
#   T3_LIVE_PORT     live server port     (default: 4101)
#   T3_SMOKE_PORT    scratch smoke port   (default: 4199)
#   T3_SKIP_BUILD=1  reuse existing apps/server/dist (skip the build step)
#
set -euo pipefail

HOST="${T3_DEPLOY_HOST:-hub}"
LIVE_PORT="${T3_LIVE_PORT:-4101}"
SMOKE_PORT="${T3_SMOKE_PORT:-4199}"
INSTALL_DIR="/home/deploy/.t3-server/node_modules/t3/dist"
SERVICE="t3-code.service"
BASE_DIR="/home/deploy/.t3"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
DIST="$REPO_ROOT/apps/server/dist"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mDEPLOY ABORTED: %s\033[0m\n' "$*" >&2; exit 1; }

# --- 0. Preflight: file-swap is only safe when server deps are unchanged --------
# Only DEPENDENCY declarations matter (file-swap skips `npm install`); a scripts
# or unrelated package.json edit must NOT block the deploy. Compare just the
# dependency-bearing fields (root deps + workspaces.catalog/overrides, and the
# server package's own deps) between main and the working tree.
say "Preflight: checking that server dependencies are unchanged vs main"
if ! git rev-parse --verify --quiet main >/dev/null; then
  echo "  (no local 'main' to compare against; skipping dep check)"
elif ! command -v python3 >/dev/null 2>&1; then
  echo "  (python3 not found; falling back to coarse check on apps/server/package.json)"
  git diff --quiet main...HEAD -- apps/server/package.json \
    || die "apps/server/package.json changed vs main — use the tarball path (npm install) instead."
  echo "  OK (coarse) — server package unchanged."
elif python3 - <<'PY'
import json, subprocess, sys
DEP_KEYS = ["dependencies","devDependencies","optionalDependencies","peerDependencies",
            "overrides","resolutions","patchedDependencies","trustedDependencies"]
def git_show(ref, path):
    try:
        return json.loads(subprocess.check_output(["git","show",f"{ref}:{path}"], text=True))
    except subprocess.CalledProcessError:
        return None
def working(path):
    try:
        with open(path) as f: return json.load(f)
    except FileNotFoundError:
        return None
def root_slice(d):
    if d is None: return None
    s = {k: d.get(k) for k in DEP_KEYS}
    s["catalog"] = (d.get("workspaces") or {}).get("catalog")
    return s
def srv_slice(d):
    return None if d is None else {k: d.get(k) for k in DEP_KEYS}
changed = (root_slice(git_show("main","package.json")) != root_slice(working("package.json"))
           or srv_slice(git_show("main","apps/server/package.json")) != srv_slice(working("apps/server/package.json")))
sys.exit(1 if changed else 0)
PY
then
  echo "  OK — dependency declarations unchanged, file-swap is safe."
else
  die "server dependency declarations changed vs main (deps/catalog/overrides).
  The file-swap deploy does NOT run 'npm install' on the VPS, so a dependency
  change would ship a bundle the VPS can't satisfy. Use the tarball path
  (scripts/pack-server.ts + npm install) for this one instead."
fi

# --- 1. Build (web FIRST: the server build copies apps/web/dist into dist/client)
if [[ "${T3_SKIP_BUILD:-}" == "1" ]]; then
  say "Skipping build (T3_SKIP_BUILD=1) — reusing $DIST"
else
  say "Building web bundle"
  CI=1 mise exec -- bun --filter=@t3tools/web run build
  say "Building server bundle (copies web dist into dist/client)"
  CI=1 mise exec -- bun --filter=t3 run build
fi

[[ -f "$DIST/bin.mjs" ]] || die "missing build artifact: $DIST/bin.mjs"
[[ -d "$DIST/client" ]] || die "missing build artifact: $DIST/client/ (web build did not land beside the server bundle)"
echo "  Artifacts present: bin.mjs + client/"

# --- 2. Stage the FULL dist INTO THE INSTALL TREE ------------------------------
# Two things make naive staging fail:
#  (a) the build CODE-SPLITS: bin.mjs imports sibling chunks (PTY-*.mjs, NodePTY-*,
#      BunPTY-*, NodeSqliteClient-*, .map) — ship the whole dist/, not just bin.mjs.
#  (b) the bundle EXTERNALIZES some node_modules deps (e.g. @effect/platform-node),
#      resolved by walking up to the install tree's node_modules. So we stage into a
#      sibling of the live dist (${INSTALL_DIR}.incoming, same depth) — that way the
#      smoke-test resolves those externals exactly as the live server does, and the
#      final swap is a cheap in-place mv. (This is the file-swap path; deps must be
#      unchanged, which the preflight guarantees.)
TS="$(date +%Y%m%d-%H%M%S)"
STAGING="/tmp/t3-deploy-$TS"            # scratch base-dir + smoke log only
INCOMING="${INSTALL_DIR}.incoming"
MJS_COUNT="$(find "$DIST" -maxdepth 1 -name '*.mjs' | wc -l | tr -d ' ')"
say "Staging full dist ($MJS_COUNT mjs files + client/) into $HOST:$INCOMING"
ssh "$HOST" "rm -rf '$INCOMING' && mkdir -p '$INCOMING' '$STAGING/scratch-basedir'"
# COPYFILE_DISABLE stops macOS bsdtar from emitting AppleDouble ._* sidecar files.
COPYFILE_DISABLE=1 tar -C "$DIST" -cf - . | ssh "$HOST" "tar -C '$INCOMING' -xf -"
echo "  Uploaded."

# --- 3-7. Remote: smoke-test -> backup -> swap -> chown -> restart -> verify ----
say "Remote: smoke-test, swap, restart, verify"
ssh "$HOST" "STAGING='$STAGING' TS='$TS' LIVE_PORT='$LIVE_PORT' SMOKE_PORT='$SMOKE_PORT' INSTALL_DIR='$INSTALL_DIR' INCOMING='$INCOMING' SERVICE='$SERVICE' BASE_DIR='$BASE_DIR' bash -s" <<'REMOTE'
set -euo pipefail
rfail() { printf '\n[remote] FAILED: %s\n' "$*" >&2; exit 1; }

DEPLOY_UID="$(id -u deploy)" || rfail "could not resolve 'deploy' uid"

# Work whether we logged in as root (need sudo to act as deploy) or as deploy
# itself (act directly). as_deploy runs a command in deploy's user-systemd context.
if [[ "$(id -u)" == "0" ]]; then
  as_deploy() { sudo -u deploy XDG_RUNTIME_DIR="/run/user/$DEPLOY_UID" "$@"; }
  NEED_CHOWN=1
else
  as_deploy() { XDG_RUNTIME_DIR="/run/user/$DEPLOY_UID" "$@"; }
  NEED_CHOWN=0   # files we write are already deploy-owned
fi

# Smoke copy must end in .mjs (node ERR_UNKNOWN_FILE_EXTENSION) and sits in $INCOMING
# beside its sibling chunks AND within the install tree, so both the relative chunk
# imports and the externalized node_modules deps resolve like the live server.
cp "$INCOMING/bin.mjs" "$INCOMING/bin.smoke.mjs"

echo "[remote] boot smoke-test on :$SMOKE_PORT (VPS node $(node -v)) before touching live files"
node "$INCOMING/bin.smoke.mjs" serve --host 127.0.0.1 --port "$SMOKE_PORT" --base-dir "$STAGING/scratch-basedir" >"$STAGING/smoke.log" 2>&1 &
SMOKE_PID=$!
trap 'kill "$SMOKE_PID" 2>/dev/null || true' EXIT

code="000"
for _ in $(seq 1 30); do
  if ! kill -0 "$SMOKE_PID" 2>/dev/null; then
    echo "----- smoke.log -----"; tail -n 40 "$STAGING/smoke.log" || true
    rfail "smoke server exited before becoming ready (new bundle does not boot on VPS node)"
  fi
  # curl -w always prints the code (000 on no-response); || true keeps set -e happy.
  code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$SMOKE_PORT/" 2>/dev/null || true)"
  code="${code:-000}"
  [[ "$code" != "000" ]] && break
  sleep 1
done
kill "$SMOKE_PID" 2>/dev/null || true; trap - EXIT
[[ "$code" == "000" ]] && { echo "----- smoke.log -----"; tail -n 40 "$STAGING/smoke.log" || true; rfail "smoke server never answered on :$SMOKE_PORT"; }
echo "[remote] smoke OK (HTTP $code) — bundle boots on the VPS"

[[ -d "$INSTALL_DIR" ]] || rfail "install dir not found: $INSTALL_DIR"
rm -f "$INCOMING/bin.smoke.mjs"   # don't ship the smoke copy

# Swap by RENAME, never rm -rf the live dir. Two renames within the (deploy-owned)
# parent: the old dist becomes the timestamped backup, the validated $INCOMING takes
# its place. Renames are atomic, never recurse, and — critically — can't partially
# delete the live dir or choke on root-owned cruft left inside it by old deploys.
echo "[remote] swapping: rename live dist -> ${INSTALL_DIR}.bak-$TS, move validated dist into place"
mv "$INSTALL_DIR" "${INSTALL_DIR}.bak-$TS"
mv "$INCOMING" "$INSTALL_DIR"
[[ "$NEED_CHOWN" == "1" ]] && chown -R deploy:deploy "$INSTALL_DIR"

# Best-effort: keep only the 3 newest backups (older ones may hold root-owned cruft
# that we can't delete as deploy — ignore failures).
ls -dt "${INSTALL_DIR}".bak-* 2>/dev/null | tail -n +4 | while read -r old; do rm -rf "$old" 2>/dev/null || true; done

echo "[remote] restarting $SERVICE"
as_deploy systemctl --user restart "$SERVICE"

echo "[remote] verifying live server on :$LIVE_PORT"
live="000"
for _ in $(seq 1 30); do
  live="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$LIVE_PORT/" 2>/dev/null || true)"
  live="${live:-000}"
  [[ "$live" =~ ^[23] ]] && break   # require a real 2xx/3xx, not just "responding"
  sleep 1
done
if [[ ! "$live" =~ ^[23] ]]; then
  echo "[remote] live server not answering — recent service log:"
  as_deploy journalctl --user -u "$SERVICE" -n 40 --no-pager || true
  echo "[remote] previous dist kept at ${INSTALL_DIR}.bak-$TS — restore: rm -rf $INSTALL_DIR && mv ${INSTALL_DIR}.bak-$TS $INSTALL_DIR && restart"
  rfail "live server did not come back up on :$LIVE_PORT"
fi
NEWPID="$(as_deploy systemctl --user show -p MainPID --value "$SERVICE" 2>/dev/null || echo '?')"
echo "[remote] LIVE OK (HTTP $live), service PID $NEWPID"
echo "[remote] cleaning up staging"
cd /tmp && rm -rf "t3-deploy-$TS"
REMOTE

say "Deploy complete — live on $HOST:$LIVE_PORT"
echo "  Rollback if needed: on $HOST, rm -rf $INSTALL_DIR && mv ${INSTALL_DIR}.bak-$TS $INSTALL_DIR, then restart $SERVICE."
