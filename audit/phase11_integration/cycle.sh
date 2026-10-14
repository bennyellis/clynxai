#!/bin/bash
# One full validation cycle of the installed Beta 2 against a throw-away copy of the Docker stack:
#   commit-clean build of Beta 2 and of a test-only 0.3.0-beta.3, fresh test stack (project clynx-lan-test, port 8796), then t20_lan_beta2.cjs.
# Never touches the real stack (clynx-lan, port 8788), the developer stack, or %APPDATA%\Clynx.
set -u
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
S="${SCRATCH:?set SCRATCH to a folder for the built installers}"
LOG="${CYCLE_LOG:-/tmp/cycle.log}"
{
  if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "== build Beta 2"
  node scripts/build-info.cjs beta >/dev/null && npm run dist:beta 2>&1 | tail -1
  cp "dist/Clynx-Beta-Setup-0.3.0-beta.2.exe" "$S/Clynx-Beta-Setup-0.3.0-beta.2.exe"
  echo "== build test-only 0.3.0-beta.3"
  sed -i 's/"version": "0.3.0-beta.2"/"version": "0.3.0-beta.3"/' package.json
  node scripts/build-info.cjs beta >/dev/null && npm run dist:beta 2>&1 | tail -1
  cp "dist/Clynx-Beta-Setup-0.3.0-beta.3.exe" "$S/Clynx-Beta-Setup-0.3.0-beta.3-TESTONLY.exe"
  rm -f dist/Clynx-Beta-Setup-0.3.0-beta.3.exe dist/Clynx-Beta-Setup-0.3.0-beta.3.exe.blockmap
  git checkout package.json
  node scripts/build-info.cjs beta >/dev/null
  fi
  echo "== fresh test stack"
  export CLYNX_ENV_FILE='C:\Users\biggt\ClynxLanTest\.env.lan' LAN_BIND=10.0.0.81 LAN_PORT=8796 CLYNX_IMAGE=clynx-lan-test-api:latest
  (cd cloud && docker compose -p clynx-lan-test -f docker-compose.lan.yml --env-file "$CLYNX_ENV_FILE" down -v 2>&1 | tail -1)
  (cd cloud/deploy/windows && CLYNX_LAN_DIR='C:\Users\biggt\ClynxLanTest' CLYNX_COMPOSE_PROJECT=clynx-lan-test powershell -NoProfile -ExecutionPolicy Bypass -File ./Start-ClynxLan.ps1 2>&1 | tail -1)
  echo "== t20"
  BETA2_EXE="$S/Clynx-Beta-Setup-0.3.0-beta.2.exe" BETA3_EXE="$S/Clynx-Beta-Setup-0.3.0-beta.3-TESTONLY.exe" SIGN_KEY="C:/Users/biggt/ClynxKeys/update-signing/update-private.pem" node audit/phase11_integration/t20_lan_beta2.cjs 2>&1
  echo "== CYCLE DONE"
} > "$LOG" 2>&1
