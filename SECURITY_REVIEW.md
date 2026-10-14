# Clynx security review (desktop app and cloud)

Written during Phase 7. It states what was checked, what was changed, what was verified by tests, and what is still open. It is a developer review, not an independent penetration test.

## Electron window
| Control | State | Verified by |
|---|---|---|
| `contextIsolation: true`, `nodeIntegration: false` | on (already) | Electron suite t14 |
| `sandbox: true` | **turned on** (preload only needs `electron`) | t14 reads the live window preferences; t15 on the packaged build |
| `webviewTag: false`, webview attach refused | **added** | unit + t14 |
| `webSecurity` / no insecure content | explicit | static test |
| Navigation away from the app (`will-navigate`, `will-redirect`) | **blocked**; http(s) links go to the system browser instead | t14 (page cannot be navigated away) |
| `window.open` / `target=_blank` | **filtered**: http(s) without embedded credentials only; `file:`, `javascript:`, custom protocols never open | unit + t14 |
| Permission requests (camera, location, notifications...) | **always refused** | t14 |
| IPC sender check | **added for every `ipcMain.handle`/`on`**: the call must come from the app's own top-level page (file in the bundled renderer folder, or the dev server) | unit (`windowSecurity.test.ts`); the real sender check runs in every Electron suite because all normal IPC passes through it |
| Content-Security-Policy | tightened: `default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'` (styles still allow inline; images allow https and data) | unit |

Not done: per-handler argument schemas. About 110 handlers take typed-but-unvalidated arguments from the renderer. With the renderer sandboxed, loading only bundled code and refusing foreign navigation, the realistic attacker is a bug in the renderer's own code or a malicious string coming from a scraped listing (XSS) - React escapes text and the CSP forbids inline scripts. Validating every handler's arguments is worthwhile hardening for later; the highest-risk handlers (billing, account, backups, support report, file/URL opening) validate theirs.

## Secrets
- **Cloud refresh token**: now stored encrypted with the operating system's key store (Electron `safeStorage`: Windows DPAPI, macOS Keychain) as `enc:v1:...`. Older plain files still read and are rewritten encrypted. A file copied to another computer or Windows account reads as "signed out". If the key store is unavailable the token is stored as before (and that is the only case). Verified: unit tests with a stand-in cipher; the Electron start-up suite confirms the real `safeStorage` encrypts and that the app signs back in from the encrypted file.
- **OpenAI / eBay keys in `.env`**: plain text by default (the user's own keys on the user's own machine; nothing is changed without being asked). Since Phase 10 there is an opt-in **"Protect my saved keys"** switch in Config > Account that encrypts just those three lines with the same key store as above (a full copy of `.env` is kept first, every key is read back and compared before the file is replaced, the switch is reversible, and the old copies can be deleted on request). Cloud accounts no longer need these keys at all: AI and eBay can come from Clynx's company-managed service. In the hosted setup the OpenAI/eBay credentials are stored only on the server, encrypted (see `PHASE10_SECURITY_AND_TESTING_REPORT.txt`).
- **Facebook session**: lives in the browser profile folder on the user's machine and is never sent to the cloud.
- **Support report**: removes keys, tokens, passwords, emails, the user's name in paths; contains no listings or photos (unit-tested).

## Dependencies (npm audit, 2026-10-13)
- Desktop, shipped (`--omit=dev`): was 2 high (sharp, brace-expansion) -> **0** after patch updates (sharp 0.35.5, brace-expansion).
- Cloud, shipped (`--omit=dev`): 0.
- Build/test tooling only (not in the installer or the server image): electron-builder 25 (and its tar/cacache/node-gyp chain, 1 critical, several high), vite 5, vitest 1 (cloud tests), concurrently. These run only on a developer or CI machine against trusted input. Fixing them needs major upgrades (electron-builder 26, vite 8, vitest 5), each of which should be done on its own with a full test run. CI now runs `npm audit --omit=dev` as an informational job.
- electron 44.2.0 is current at the time of writing; keep it updated, since Chromium fixes ship through Electron releases.

## Packaging
- Before: electron-builder had no `files` list and packed the whole project folder (a 5 GB `app.asar` including the cloud server, audits, profiles and reports). Now only `out/**`, `resources/**`, `package.json` and production dependencies are packed (25 MB archive, 411 MB unpacked with Electron itself). A test guards the whitelist.
- `publish: null`: electron-builder can never upload anything.
- Native `sharp` is unpacked from the archive and works (t15).
- Unsigned: Windows SmartScreen will warn until a code-signing certificate is used. macOS builds cannot be notarised without an Apple Developer account. Neither exists yet.

## Signed updates (designed, tested, not wired)
`src/main/updateVerifier.ts`: Ed25519-signed manifest; the app holds only the public key. An update is offered only if the signature verifies, it is newer, for this channel/platform, not older than the newest manifest ever seen (replay), and not a version that failed here before. The download is untrusted until its size and SHA-512 match the signed manifest (https only, size-capped, partial files removed). After installing, a version must start healthily; if it does not within 3 starts it is recorded as bad and the previous version is kept. `scripts/update-keys.cjs` generates keys offline, signs manifests and hashes installers. **Missing**: the update server/URL, a public key baked into a release, the "download and install" UI, and the installer hand-off - these need a release host and a signing key that only the owner can create.

## Data protection
- Database: integrity check at start and in the background, damaged files moved aside (never deleted), automatic verified backups (daily at most; newest 3 plus one per recent week), one-click restore that keeps the replaced database. All covered by unit tests; backup/restore start-up path covered by Electron suite t14.
- Cloud: Postgres dumps and restore drill in `cloud/DEPLOYMENT.md`; account deletion removes all synced rows and cancels the subscription first.

## Cloud server (summary; details in `cloud/DEPLOYMENT.md`)
Argon2id passwords, refresh-token rotation with reuse detection, per-user data scoping tested for every resource, rate limits (login per IP+email, registration, checkout), allow-listed AI models with output caps and metering, verified and idempotent billing webhooks, security headers, run as non-root.

## Known gaps (not fixed here)
1. Password reset and email verification exist (Phase 10) but have only been tested with captured email; a real mail provider is needed.
2. No two-factor authentication.
3. IPC argument validation is partial (see above).
4. `.env` keys are plain text unless the person turns on the opt-in protection (Phase 10).
5. Update delivery is not built (verification core only).
6. Windows installer is unsigned; macOS never built.
7. Billing never exercised against Stripe's servers (no test credentials were available).
8. Facebook's terms restrict automated access; get legal advice before offering Clynx commercially.
