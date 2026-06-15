#!/usr/bin/env bash
#
# Tarball deploy of the t3 fork server to the VPS — the DEPS-CHANGED path.
#
#   pnpm run deploy:tarball
#
# Use this (not scripts/deploy-vps.sh) when server dependencies changed — e.g.
# after the v0.0.27 toolchain migration. The file-swap deploy only ships dist/
# and never runs `npm install` on the VPS, so it refuses when deps changed. This
# path ships a self-installable npm tarball (catalog: deps resolved to concrete
# versions by scripts/pack-server.ts) and runs `npm install` into a FRESH
# staging prefix on the VPS, rebuilding the whole dependency tree.
#
# Safety mirrors the file-swap runbook — the live prefix is never touched until
# the new bundle has booted on the VPS:
#   build -> pack -> ship -> install into a SIBLING staging prefix ->
#   boot smoke-test on a scratch port + scratch base-dir ->
#   swap the prefix by atomic rename (old -> timestamped backup) ->
#   restart the user service -> verify HTTP 2xx, with AUTOMATIC ROLLBACK if the
#   live server does not come back.
#
# VPS layout (see scripts/deploy-vps.sh): `ssh hub` lands as user `deploy`
# (uid 1001); the server is a systemd USER service launched by system node as
#   node $PREFIX/node_modules/t3/dist/bin.mjs serve --host 127.0.0.1 \
#        --port 4101 --base-dir /home/deploy/.t3
# and the bundle's externalized deps resolve from the flat node_modules under
# $PREFIX. So we install into a whole replacement $PREFIX and swap it atomically.
#
# Overridable via env:
#   T3_DEPLOY_HOST   ssh target          (default: hub)
#   T3_LIVE_PORT     live server port    (default: 4101)
#   T3_SMOKE_PORT    scratch smoke port  (default: 4199)
#   T3_SKIP_BUILD=1  reuse existing apps/server/dist (skip the build step)
#
set -euo pipefail

HOST="${T3_DEPLOY_HOST:-hub}"
LIVE_PORT="${T3_LIVE_PORT:-4101}"
SMOKE_PORT="${T3_SMOKE_PORT:-4199}"
PREFIX="/home/deploy/.t3-server"
BASE_DIR="/home/deploy/.t3"
SERVICE="t3-code.service"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
DIST="$REPO_ROOT/apps/server/dist"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mDEPLOY ABORTED: %s\033[0m\n' "$*" >&2; exit 1; }

VERSION="$(node -p "require('./apps/server/package.json').version")" || die "could not read server version"
TGZ_LOCAL="$REPO_ROOT/apps/server/t3-${VERSION}.tgz"
TGZ_REMOTE="/tmp/t3-${VERSION}.tgz"

# --- 1. Build (web FIRST: the server build copies apps/web/dist into dist/client)
if [[ "${T3_SKIP_BUILD:-}" == "1" ]]; then
  say "Skipping build (T3_SKIP_BUILD=1) — reusing $DIST"
else
  say "Building web bundle"
  CI=1 pnpm exec vp run --filter @t3tools/web build
  say "Building server bundle (copies web dist into dist/client)"
  CI=1 pnpm exec vp run --filter t3 build
fi
[[ -f "$DIST/bin.mjs" ]] || die "missing build artifact: $DIST/bin.mjs"
[[ -d "$DIST/client" ]] || die "missing build artifact: $DIST/client/ (web build did not land beside the server bundle)"

# --- 2. Pack the self-installable tarball (catalog: -> concrete versions) -------
say "Packing tarball t3-${VERSION}.tgz"
rm -f "$REPO_ROOT"/apps/server/t3-*.tgz
node scripts/pack-server.ts
[[ -f "$TGZ_LOCAL" ]] || die "pack-server did not produce $TGZ_LOCAL"

# --- 3. Ship the tarball to the VPS /tmp ---------------------------------------
say "Shipping $(du -h "$TGZ_LOCAL" | cut -f1) tarball to $HOST:$TGZ_REMOTE"
scp -q "$TGZ_LOCAL" "$HOST:$TGZ_REMOTE"
echo "  Uploaded."

# --- 4. Remote: install staging prefix -> smoke -> swap -> restart -> verify ----
TS="$(date +%Y%m%d-%H%M%S)"
say "Remote: install staging prefix, smoke-test, swap, restart, verify"
ssh "$HOST" "PREFIX='$PREFIX' BASE_DIR='$BASE_DIR' SERVICE='$SERVICE' LIVE_PORT='$LIVE_PORT' SMOKE_PORT='$SMOKE_PORT' TGZ='$TGZ_REMOTE' VERSION='$VERSION' TS='$TS' bash -s" <<'REMOTE'
set -euo pipefail
rfail() { printf '\n[remote] FAILED: %s\n' "$*" >&2; exit 1; }

export XDG_RUNTIME_DIR="/run/user/$(id -u)"   # we are the deploy user; user-systemd context
INCOMING="${PREFIX}.incoming"
SCRATCH="/tmp/t3-smoke-$TS"

[[ -f "$TGZ" ]] || rfail "tarball not found on VPS: $TGZ"

# 4a. Fresh staging prefix + npm install of the tarball (rebuilds the dep tree).
echo "[remote] installing t3@$VERSION into staging prefix $INCOMING (node $(node -v), npm $(npm -v))"
rm -rf "$INCOMING"
mkdir -p "$INCOMING"
printf '{\n  "dependencies": { "t3": "file:%s" }\n}\n' "$TGZ" > "$INCOMING/package.json"
if ! ( cd "$INCOMING" && npm install --no-audit --no-fund --loglevel=error ); then
  rm -rf "$INCOMING"
  rfail "npm install of the tarball failed (live prefix untouched)"
fi
[[ -f "$INCOMING/node_modules/t3/dist/bin.mjs" ]] || { rm -rf "$INCOMING"; rfail "installed tree missing node_modules/t3/dist/bin.mjs"; }
echo "[remote] staging install OK"

# 4b. Boot smoke-test on a scratch port + scratch base-dir, BEFORE touching live.
mkdir -p "$SCRATCH/basedir"
echo "[remote] boot smoke-test on :$SMOKE_PORT (scratch base-dir, live :$LIVE_PORT untouched)"
node "$INCOMING/node_modules/t3/dist/bin.mjs" serve --host 127.0.0.1 --port "$SMOKE_PORT" --base-dir "$SCRATCH/basedir" >"$SCRATCH/smoke.log" 2>&1 &
SMOKE_PID=$!
trap 'kill "$SMOKE_PID" 2>/dev/null || true' EXIT
code="000"
for _ in $(seq 1 30); do
  if ! kill -0 "$SMOKE_PID" 2>/dev/null; then
    echo "----- smoke.log -----"; tail -n 40 "$SCRATCH/smoke.log" || true
    rm -rf "$INCOMING" "$SCRATCH"
    rfail "smoke server exited before becoming ready (new bundle does not boot on VPS node)"
  fi
  code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$SMOKE_PORT/" 2>/dev/null || true)"
  code="${code:-000}"
  [[ "$code" != "000" ]] && break
  sleep 1
done
kill "$SMOKE_PID" 2>/dev/null || true; trap - EXIT
if [[ "$code" == "000" ]]; then
  echo "----- smoke.log -----"; tail -n 40 "$SCRATCH/smoke.log" || true
  rm -rf "$INCOMING" "$SCRATCH"
  rfail "smoke server never answered on :$SMOKE_PORT"
fi
echo "[remote] smoke OK (HTTP $code) — new bundle boots on the VPS"
rm -rf "$SCRATCH"

# 4c. Swap by atomic rename: live prefix -> timestamped backup, staging -> live.
[[ -d "$PREFIX" ]] || rfail "live prefix not found: $PREFIX"
echo "[remote] swapping prefix: $PREFIX -> ${PREFIX}.bak-$TS, staged tree -> live"
mv "$PREFIX" "${PREFIX}.bak-$TS"
mv "$INCOMING" "$PREFIX"

echo "[remote] restarting $SERVICE"
systemctl --user restart "$SERVICE"

echo "[remote] verifying live server on :$LIVE_PORT"
live="000"
for _ in $(seq 1 30); do
  live="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$LIVE_PORT/" 2>/dev/null || true)"
  live="${live:-000}"
  [[ "$live" =~ ^[23] ]] && break   # require a real 2xx/3xx, not just "responding"
  sleep 1
done
if [[ ! "$live" =~ ^[23] ]]; then
  echo "[remote] live server not answering — ROLLING BACK to ${PREFIX}.bak-$TS"
  rm -rf "$PREFIX"
  mv "${PREFIX}.bak-$TS" "$PREFIX"
  systemctl --user restart "$SERVICE"
  echo "[remote] recent service log:"; journalctl --user -u "$SERVICE" -n 40 --no-pager || true
  rfail "live server did not come back up on :$LIVE_PORT — ROLLED BACK to previous prefix"
fi
NEWPID="$(systemctl --user show -p MainPID --value "$SERVICE" 2>/dev/null || echo '?')"
STARTED="$(systemctl --user show -p ExecMainStartTimestamp --value "$SERVICE" 2>/dev/null || echo '?')"
echo "[remote] LIVE OK (HTTP $live), t3@$VERSION, service PID $NEWPID, started $STARTED"

# Keep only the 3 newest prefix backups (best-effort).
ls -dt "${PREFIX}".bak-* 2>/dev/null | tail -n +4 | while read -r old; do rm -rf "$old" 2>/dev/null || true; done
echo "[remote] done"
REMOTE

say "Tarball deploy complete — t3@${VERSION} live on $HOST:$LIVE_PORT"
echo "  Rollback if needed: on $HOST, rm -rf $PREFIX && mv ${PREFIX}.bak-$TS $PREFIX, then:"
echo "    XDG_RUNTIME_DIR=/run/user/\$(id -u) systemctl --user restart $SERVICE"
