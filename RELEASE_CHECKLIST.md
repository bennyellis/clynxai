# Clynx release checklist

Nothing in this repository publishes, signs with real certificates, or charges anyone by itself. This is the list of things a person does, in order, to ship a build.
Mark each item only when it was actually done and checked.

## 1. Before building
- [ ] `git status` is clean on the commit being released; the commit is tagged (`vX.Y.Z`).
- [ ] `npm run typecheck` passes (desktop, both tsconfigs).
- [ ] `npm test` passes (all unit files).
- [ ] `cd cloud && npm run typecheck && npx vitest run` passes (needs Postgres + Redis; CI does this).
- [ ] `npm audit --omit=dev` and `cd cloud && npm audit --omit=dev` show no high or critical findings, or each one is understood and written down.
- [ ] The Electron integration suites pass on a Windows machine (`integ/run_all.sh` style run: startup, big database, config, session, close/recovery, onboarding, status feed, modes, diagnostics, leaks, identity, review).
- [ ] `version` in `package.json` is bumped.

## 2. Building (Windows)
- [ ] `npm run dist:win` produces `dist/Clynx-<version>-win-x64.exe` and finishes without errors.
- [ ] The installer is **signed** with the Windows code-signing certificate (`CSC_LINK`, `CSC_KEY_PASSWORD`). An unsigned installer triggers SmartScreen warnings; do not ship it to customers.
- [ ] Install it on a clean Windows machine/VM (no Node, no Chrome profile of yours): it starts, the login screen shows, a test account signs in, **a scan runs** (see "Browser" below).
- [ ] Uninstall keeps the user's data folder (it must; `deleteAppDataOnUninstall` is false).

### Windows beta build (done once, 0.3.0-beta.1)
- `npm run dist:beta` writes `resources/build-info.json` (channel "beta", version, git commit), builds, and runs electron-builder. Only beta builds offer the local no-account mode; a production build never does.
- On a Windows PC without Developer Mode / administrator rights, electron-builder fails while unpacking its signing tools ("Cannot create symbolic link"). The workaround used: run `CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --win --x64` once with Developer Mode enabled, or copy a partially unpacked `winCodeSign` folder to `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0`.
- Results, checksum and tester guides: `BETA_TEST_RESULTS.txt`, `beta-release/`.

## 3. Building (macOS) - not yet validated
No Mac or Apple Developer account was available when this was written. The configuration (`build.mac`, `dist:mac`, the CI job) exists but has **never been run**.
- [ ] Apple Developer Program membership; Developer ID Application certificate; `CSC_LINK`/`CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` set as repository secrets.
- [ ] A 1024x1024 app icon (`build/icon.icns` or a 1024 px PNG) - the current `resources/icon.png` is 256x256, too small for macOS.
- [ ] `npm run dist:mac` on a Mac (or the manual "Release build" workflow); notarisation succeeds.
- [ ] Install on a clean Mac (Apple silicon and Intel): start, sign in, scan, copy/paste in text fields, quit with Cmd+Q.

## 4. Browser (needed for Facebook scanning)
Clynx drives a real browser to read Marketplace. It uses the machine's Google Chrome; if Chrome is missing it falls back to Playwright's bundled Chromium, which is **downloaded by the developer install step and is not inside the installer**.
- [ ] Decide the customer story: require Google Chrome (simplest), or add a first-run "download browser" step. Until then the installer's first-run notes must say Chrome is required.

## 5. Cloud
- [ ] Follow `cloud/DEPLOYMENT.md`: secrets generated, TLS in front, backups scheduled and one restore tested.
- [ ] Billing is still in Stripe **test mode**; complete the test-card runs in DEPLOYMENT.md (success, failed renewal, cancel, webhook replay) before any live key is created.
- [ ] `ENFORCE_ENTITLEMENTS` stays `false` until plan numbers are final and existing users are on the right plan.

## 6. Updates (signed-update design, not yet wired)
- [ ] Generate the update signing key pair offline: `node scripts/update-keys.cjs keygen <offline folder>`. The private key never touches this repository or a CI secret store you do not control.
- [ ] Build and hash the installer (`update-keys.cjs hash <file>`), write the manifest, sign it (`update-keys.cjs sign ...`), upload the installer and the signed manifest to an https location.
- [ ] Remember the app side (download, install hand-off, restart) is still to be built on top of `src/main/updateVerifier.ts`; see SECURITY_REVIEW.md.

## 7. Publishing (a person decides; nothing automatic)
- [ ] Inspect the workflow artifact, run the installer once more, then upload to the download page / GitHub release by hand.
- [ ] Tell beta users what changed and how to go back (BETA_PLAN.md: rollback).

## 8. After release
- [ ] Watch `/health`, `/metrics` and the support diagnostics bundles users send.
- [ ] Keep the previous installer available for at least one release.
