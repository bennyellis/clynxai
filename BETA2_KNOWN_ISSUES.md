# Clynx Windows Beta 2 (0.3.0-beta.2) — known issues and limits

## About this build
* Windows x64 only; per-user NSIS installer, **not code-signed** (SmartScreen warns). macOS was never built.
* Local mode is unchanged from Beta 1. Server mode needs a Clynx server (see `LAN_SETUP_GUIDE.md`).
* Updates are verified with Clynx's own Ed25519 signature and SHA-512/SHA-256; that is separate from Windows code signing, which this build does not have.

## What has and has not been tested
* **Tested on the build host with the real installed Beta 2 and a real Docker server reached over the Wi-Fi address (not localhost):** server address check, registration, device registration, Owner recognition, shared-AI routing (answer "unavailable" because no company key is configured), database persistence, server stop/start (offline notice, automatic reconnection), a server update while a client was connected, a signed update install, health check, and a user-approved return to the earlier version. 60/60 checks in `audit/phase11_integration/t20_result.log`.
* **NOT tested:** a second physical computer (none was available). Same-machine-over-LAN-address tests prove the network path, the Docker bindings and the installed app, but not a second computer's firewall, Wi-Fi isolation, antivirus, SmartScreen or first-ever install with no developer tools. Follow `SECOND_COMPUTER_TEST_PLAN.md` and tell us what you see.
* **NOT tested:** real OpenAI or eBay calls (no paid call was made), Stripe, real email, HTTPS on a real domain, a Windows-code-signed installer.

## Behaviour you may notice
* The server's address has no default in an installed build: you type it once (it is remembered).
* Granting the Owner role signs that account out everywhere, once.
* "Working offline" appears within about 30–60 seconds of the server going away (the app checks every 30 s) and clears within about 15 s of its return.
* An update installed by the app reopens Clynx a few seconds after the installer finishes; the screen may flash once.
* Going back to an earlier version works only while that version is still published on the server (or its installer was kept by an earlier update); otherwise install the earlier installer by hand.
* Automatic updates in server mode only; local mode never checks.
* The first automatic update from Beta 2 has no kept earlier installer on the computer, so "Go back" downloads it from the server (signed and verified like an update).

## Not in this beta
Mobile apps, a public internet server, code signing, automatic updates for local mode, macOS, two-factor sign-in.

## Added in revision B (private beta)
* A private server checks your sign-in on update checks and downloads, so updates work only while you are signed in. Signed out, Clynx simply does not check.
* An "all users" (per-machine) install makes the silent update installer ask for administrator rights (a Windows UAC prompt) every time. Install "only for me".
* The update hand-off waits for that prompt; if it is dismissed the update does not install and Clynx reopens on the old version.
