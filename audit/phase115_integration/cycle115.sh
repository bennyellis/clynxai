#!/bin/bash
# One full validation cycle of the installed Beta 2 against a throw-away copy of the Docker stack:
#   clean-tree build of Beta 2 and of a test-only 0.3.0-beta.3 (skip with SKIP_BUILD=1), a fresh test stack (compose project "clynx-lan-test", port 8796, own volumes), then
#   t21_private_beta.cjs, then the test stack is removed again.
# Never touches the real stack (clynx-lan, port 8788), the developer stack, or %APPDATA%\Clynx.  Needs SCRATCH (a folder for the built installers).
set -u
cd "$(dirname "$0")/../.."
S="${SCRATCH:?set SCRATCH to a folder for the built installers}"
LOG="${CYCLE_LOG:-/tmp/cycle115.log}"
TESTDIR='C:\Users\biggt\ClynxLanTest'
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
  export CLYNX_ENV_FILE="$TESTDIR\\.env.lan" LAN_BIND=10.0.0.81 LAN_PORT=8796 CLYNX_IMAGE=clynx-lan-test-api:latest
  (cd cloud && docker compose -p clynx-lan-test -f docker-compose.lan.yml --env-file "$CLYNX_ENV_FILE" down -v 2>&1 | tail -1)
  (cd cloud/deploy/windows && CLYNX_LAN_DIR="$TESTDIR" powershell -NoProfile -ExecutionPolicy Bypass -File ./Initialize-ClynxLan.ps1 -Port 8796 -ServerName "Clynx TEST server" -UpdatePublicKeyFile 'C:\Users\biggt\ClynxKeys\update-signing\update-public.pem' 2>&1 | tail -1)
  (cd cloud/deploy/windows && CLYNX_LAN_DIR="$TESTDIR" CLYNX_COMPOSE_PROJECT=clynx-lan-test powershell -NoProfile -ExecutionPolicy Bypass -File ./Start-ClynxLan.ps1 2>&1 | tail -1)
  echo "== t21"
  BETA2_EXE="$S/Clynx-Beta-Setup-0.3.0-beta.2.exe" BETA3_EXE="$S/Clynx-Beta-Setup-0.3.0-beta.3-TESTONLY.exe" SIGN_KEY="C:/Users/biggt/ClynxKeys/update-signing/update-private.pem" node audit/phase115_integration/t21_private_beta.cjs 2>&1
  echo "== removing the throw-away test stack"
  (cd cloud && docker compose -p clynx-lan-test -f docker-compose.lan.yml --env-file "$CLYNX_ENV_FILE" down -v 2>&1 | tail -1)
  docker rmi clynx-lan-test-api:latest 2>&1 | tail -1
  rm -rf /c/Users/biggt/ClynxLanTest
  echo "== CYCLE DONE"
} > "$LOG" 2>&1
