# Clynx Phase 11.7 - Automatic Update Audit and Fix

Date: 2026-10-14. Rollback point: git tag `phase117-start-checkpoint` (the commit before any Phase 11.7 change). Product code changed; nothing was published; nothing on your real server was modified except two new unpublished DRAFT releases (section 7).

**Evidence tags:** `[code]` read in the source - `[unit]` automated unit/integration test - `[e2e]` the real packaged app against a throw-away server (real signatures, real downloads, a harmless stand-in for the installer) - `[physical]` needs the second PC (section 8).

---------------------------------------------------------------------------------------------------------------------------------------------

## 1. Summary

**Goal:** publishing a release should make every existing Clynx update itself, safely, without anyone reinstalling.

**Result:** true for every install from **Beta 4 onwards**. For the **Beta 3** installs that exist today (your friend's PC) it is *almost* true: Beta 3 downloads and verifies Beta 4 by itself, then needs **one click** on "Restart and install". That cannot be removed: Beta 3's code never installs without a click, and a server cannot change code that is already installed. Every update after Beta 4 is fully automatic. `[e2e]` (scenario C below proves exactly what Beta 3 does.)

What was found, in short: the downloading, verifying, rollback and recovery parts were already solid. What was missing: (1) nothing installed by itself, (2) no way to make an update compulsory, (3) a release withdrawn after it was downloaded would still be installed, (4) the "Owner only" rule was not true for releases (any administrator could publish), (5) an interrupted 120 MB download started over, (6) a failed check was retried only after 6 hours, (7) the Owner could not see which version each computer runs (every Beta 3 computer reported its version as "unknown"), (8) the update screen said little.

---------------------------------------------------------------------------------------------------------------------------------------------

## 2. What already existed vs what was missing

| Requirement | Before | Now |
|---|---|---|
| Check, download, verify | Existed: signed manifest (Ed25519), SHA-512 + SHA-256, size check, no downgrade, replay protection, bearer token only to its own server `[code][unit]` | Unchanged (not weakened) |
| Install and restart | Only after the person clicked | **Automatic** by default when Clynx is idle; click still possible |
| Rollback / failure recovery | Existed: pending-version watch, 3 failed starts = bad version + one-click way back, "installer did not finish" detection | Unchanged; plus a failed install is never retried in a loop |
| Data preserved | Database backup before install; installer never touches user data | Unchanged; running scanners are restarted after the update |
| Not interrupting scans/research | Not applicable (never automatic) | Waits for scan, Watch check, research and the person at the keyboard; after 12 h it goes ahead anyway; scanners restart afterwards |
| Mandatory updates | None | **Owner can require a release by a deadline**; applies even if the person chose "off" |
| Owner-only release control | Any administrator could approve, publish, withdraw | **Owner only** (server-enforced and in the console) |
| Withdrawn release | Already-downloaded copy would still install | Re-checked with the server immediately before installing; dropped if withdrawn or replaced |
| Interrupted download | Started over | **Resumes** (HTTP Range); falls back to a fresh download if the server cannot resume |
| Retries | Every 6 hours | Hourly check; after a failure retries at 5, 15, 30 minutes |
| Expired sign-in during a check | Failed until the next try | One automatic token refresh and retry |
| Visibility | Little | Plain-words status: what it is waiting for, when it will retry, required-by date; Owner console shows computers per version |

---------------------------------------------------------------------------------------------------------------------------------------------

## 3. How it works now

**Desktop (`src/main/updater.ts`, `updateVerifier.ts`, `index.ts`, `UpdatesSection.tsx`)**
1. Two minutes after start, then every hour, the app asks its server for the newest signed release (also in the "off" setting, quietly, so it hears about a required one).
2. It verifies the signature and everything else exactly as before. A release that fails verification is ignored and never installed, required or not.
3. It downloads to a staging folder, resuming a cut-off download, and verifies size and both checksums.
4. **Automatic mode (the default)** then installs when ALL are true: the app has been open 90 s; the running version has proven it starts; no scan, Watch check or research is running; the person is not at the keyboard with Clynx in front (input in the last minute); and the server confirms once more that this release is still the one on offer. If a scan keeps running, it waits at most 12 hours.
5. Before the hand-over it backs up the Database and notes which scanners are running; the installer replaces the program files (data folders are outside the install folder), Clynx reopens on the same data and restarts those scanners 20 s later.
6. A release whose installer did not finish is not retried by itself (except a required one, after 6 h); a version that fails to start 3 times is marked bad and a one-click way back is offered (unchanged).

**Required updates (Owner only).** In the console, Releases, a published release with a verified signed manifest has "Require this update" with a number of hours. Apps that are online and behind that version install it by the deadline whatever the person chose: until the deadline it still waits for an idle moment; after the deadline a running scan gets 10 more minutes, then the update goes ahead (scanners restart afterwards). Time is measured from the server's clock at the last check using a clock that ignores the person changing the computer's clock `[unit]`. "Lift the requirement" and "Withdraw" both clear it. Trust decision: the "required" flag is not signed; it only tells an app *when* to install a release the app has verified itself, so a hostile server could at worst make a genuine signed release install sooner. It cannot make anything unsigned install.

**Server (`cloud/src`)**: migration 016 (`required_at`, `required_deadline`); `POST/DELETE /admin/releases/:id/require`; `/updates/:channel/latest` also returns `required` and `serverTime`; the installer download answers `Range` requests (206/416); every release-changing route is Owner-only; heartbeats carry the app version; the console overview lists computers per version.

---------------------------------------------------------------------------------------------------------------------------------------------

## 3b. API keys: nobody should have to bring their own (added at your request during this phase)

Finding: the screen you hit ("Route GET:/ebay/search ... not found") means a signed-in Clynx asked a Clynx **server** for eBay and that server did not have the feature. The development server at `127.0.0.1:8787` runs an image built before the eBay feature existed (your home server on 8788 and the public address have it, and answer "sign-in required"). Separately, the real server has **no eBay or OpenAI key saved**, so even a current server would refuse (503): this is why the remote tester's 5 AI calls and 1 eBay search failed in the Phase 11.6 audit.

Changes made: a signed-in account now uses Clynx's shared AI and eBay **by default**; saved keys on the computer no longer switch it away (they are used only if the person deliberately chooses "my own keys"); eBay failures now say the cause and who fixes it ("too old server", "the Owner has not saved the eBay keys yet") instead of a raw route error; the Config text no longer tells a signed-in user to edit `.env`. `[unit]` (24 checks in `sharedApis.test.ts`).

**What only you can do (I did not touch your keys):** your eBay keys on this PC are stored encrypted and only Clynx can read them, and I do not handle your OpenAI key. Put the company keys on the server once: open the website console as the Owner (`https://ben.tail0e333d.ts.net/console/integrations`, and `http://localhost:8787/console/integrations` for the development server), paste the OpenAI key and the eBay Client ID and Client Secret, press Save and Test. They are encrypted on the server, shown only masked, and every Clynx then uses them (with the per-person and global spending limits already set). For the development server also rebuild its image first (`docker compose up -d --build api worker` in `cloud\`).

## 4. Files changed

Desktop: `src/main/updater.ts`, `updateVerifier.ts`, `index.ts` (busy detection, scanner resume, notices, wiring), `cloudClient.ts` (real version on register/heartbeat, token refresh hook), `src/preload/index.ts`, `src/renderer/src/screens/UpdatesSection.tsx`.
Server: `cloud/src/admin/routes.ts`, `updates/routes.ts`, `releases/routes.ts`, `releases/storage.ts`, `devices/routes.ts`, `db/migrations/016_release_required.sql`.
Website: `website/src/pages/console/Console.tsx`.
Tests/evidence: `src/main/__tests__/updater.test.ts`, `cloud/test/updateEnforcement.test.ts`, `cloud/test/helpers/web.ts` (+ existing release tests now use an Owner), `website/e2e/e2e.cjs`, `audit/phase116/t24_auto_update.cjs`, `audit/phase117/t25_update_scenarios.cjs`, logs in `audit/phase117/`.
Docs: `release-notes/0.3.0-beta.4.txt`, `0.3.0-beta.5.txt`, `PRIVATE_BETA_GUIDE.md`.

---------------------------------------------------------------------------------------------------------------------------------------------

## 5. Test results

| Area | Result |
|---|---|
| Updater unit tests (`updater.test.ts`) | **103 checks pass**: automatic install timing, busy/idle/12 h, start grace, unproven version, failed-install no-loop, required in every mode, overdue grace, clock set back, lifted requirement, bad signature never installed, withdrawn/replaced/unreachable at install time, skipped versions (beta.3 straight to beta.6), bad version skipped, server errors counted, 401 refresh+retry, interrupted download resumes, server without Range, damaged kept part thrown away |
| Cloud server | **299 tests pass** (incl. 8 new): admin gets 403 on every release change, Owner can require/lift, bounds and preconditions, highest-required floor, withdraw clears, Range 206/416 and counted once, version reporting and overview |
| Desktop unit suite / typechecks | 48 of 48 files pass; main, renderer, cloud and website typecheck clean |
| Website | 11 unit tests pass; browser E2E **32 of 32** (new: an administrator sees no release buttons and the server refuses; the Owner publishes) |
| Beta 3 sign-in regression (t22) | 24/24 (run in Phase 11.6 on the same code line) |
| **Scenario A** `[e2e]`: Beta 4 app, setting on "off", Owner REQUIRED the release (deadline already past), first download cut off half way | **11 of 11** (final run on the corrected build): the app found the required update although the setting was "off", the first download was cut off after 10,000 bytes, the second try asked only for the rest (`Range: bytes=10000-`, answered 206), the whole file passed its checksums, the app closed itself 481 s after start, recorded the hand-over and the required mark, and reopened by itself. (Earlier runs failed this check twice: first the start-up tidy-up deleted the kept part (real defect, fixed), then my test proxy cut the connection before any byte arrived (test mistake, fixed).) |
| **Scenario B** `[e2e]`: update downloaded, then the Owner withdraws it | **9 of 9**: the app did not install it five minutes later, no longer reports it ready, no hand-over |
| **Scenario C** `[e2e]`: the real **Beta 3** build (unpacked from its published installer) | **11 of 11**: downloads and verifies the new release by itself; ignores "required" and waits; one click hands it over; closes and reopens by itself |
| Automatic install, no one touching the app (t24) | 13 of 13: found, downloaded, verified and installed itself 181 s after start; reopened; 5 minutes later no loop |
| Server upgrade path | The throw-away server's existing database took migration 016 without trouble when its image was rebuilt |

How the end-to-end runs work: the real packaged app, a throw-away copy of the server, a real release signed with the real offline update key (on the throw-away server only), real downloads over HTTP, real timers (the app waits 2 minutes before its first check). The "installer" is a harmless copy of `hostname.exe`, so nothing is installed, no administrator prompt appears and nothing outside the test folder changes.

**Defects the testing found and I fixed:** (1) the start-up tidy-up deleted a half-downloaded update so resuming never happened; (2) a cut-off download's already-received bytes were discarded before they reached disk; (3) every computer reported its version as "unknown" (the packaged app has no npm environment); (4) a "required" version that is known to fail on this computer would have shown a false banner. Test-harness mistakes I made and fixed: my first cut-off proxy cut the connection before any byte arrived; the throw-away server's sign-up rate limit stopped one run; one run used a server image from before the change.

---------------------------------------------------------------------------------------------------------------------------------------------

## 6. Remaining risks (honest)

1. **Beta 3 installs need one click** for Beta 4 (above).
2. **Real installer on a real PC not repeated this phase.** The end-to-end runs use a stand-in installer because a stale per-machine "Clynx (beta)" entry on this PC would make any real installer show a Windows administrator prompt. The real installer hand-off (`start /wait`, silent, data intact, reopen) was verified in Phases 11 and 11.5 with real per-user installs; the second-PC test (section 8) re-verifies it. Uninstalling that entry (Settings, Apps) lets me rerun it here.
3. **Scanner restart after an update is code-reviewed, not exercised live** (a live scan needs a Facebook session). Watches resume by themselves at start.
4. **Your real server runs the old code.** Beta 4 works against it (it ignores the new fields and cannot resume downloads), but Owner-only releases, "Require this update", resumable downloads and the version table need the new server code: `cloud\deploy\windows\Update-ClynxLan.ps1` (backs up first, rolls back by itself if unhealthy; migration 016 is additive). I did not do this without your approval.
5. **Funnel and Range requests, and 119 MB downloads (about 1 minute each at about 2 MB/s)** are untested over the real tunnel; many computers updating at once share your home uplink.
6. **The host PC must be on and reachable** for updates to arrive (sleep setting, Docker auto-start: see the Phase 11.6 audit).
7. **SmartScreen / antivirus** may react to an unsigned installer started by the app; unsigned installers remain a limit until a code-signing certificate exists.
8. **Required flag is unsigned** (trust decision in section 3). A computer that is offline or closed cannot be forced; it updates the next time it is online.

**Real-world finding (friend's PC, Beta 2):** the first real update attempt failed twice with "ENOENT ... rename ...exe.part". The server log showed both 119 MB downloads completed (107 s and 154 s, about 1 MB/s through the tunnel). Cause: Beta 2 and Beta 3 delete their staging folder 2 minutes after Clynx opens, which landed in the middle of the download; closing and reopening Clynx between tries (confirmed by the friend) restarted that 2-minute clock and hit it again. Fixed in Beta 4 (the folder of the release being downloaded is never tidied away) and covered by a unit test and by the cut-off-download scenario. Beta 2/Beta 3 PCs therefore get Beta 4 by installing it by hand (download page) or by pressing "Check for updates" once and NOT restarting Clynx. My own Beta 3 scenario missed this because its stand-in installer was tiny and downloaded instantly; the friend's PC is the first test with a real 119 MB download.

---------------------------------------------------------------------------------------------------------------------------------------------

## 7. What is prepared on your real server (signed DRAFTS, not published)

Registered with `Register-ClynxRelease.ps1` (signed with your offline key here; the server verified the signature and the stored file; both show "auto-update ready"):

| Release | File (in `beta-release\`) | Size | SHA-256 | Status |
|---|---|---|---|---|
| **0.3.0-beta.4** | `Clynx-Beta-Setup-0.3.0-beta.4.exe` | 124,741,467 bytes | `53241926cbfbd56a8a154b0c992e781eeabd9bee2ad5554b4c03d79c35309046` | DRAFT |
| **0.3.0-beta.5** (update test only; identical to Beta 4 apart from the version) | `Clynx-Beta-Setup-0.3.0-beta.5.exe` | 124,741,367 bytes | `f251c0d4261b160b7a1736e0065c9bbf7085588daf4261f22f3e1c2171e471d1` | DRAFT |

Beta 4 was built from a clean git commit (`51202a4`) with the server address `https://ben.tail0e333d.ts.net` built in; Beta 5 from the side branch `test-beta5` (one commit on top, version only). Beta 2 and Beta 3 are still the published releases; nothing was approved or published. The installers are not Windows code-signed (SmartScreen shows "unknown publisher"); "signed" means the update manifest.

---------------------------------------------------------------------------------------------------------------------------------------------

## 8. Instructions: Beta 3 to Beta 4 to Beta 5 on your friend's PC

**Before you start (one time, on this PC):**
1. *(Recommended)* Deploy the new server code so Owner-only, "Require" and the version table are live: open PowerShell in `cloud\deploy\windows` and run `.\Update-ClynxLan.ps1`. Check `https://ben.tail0e333d.ts.net/health/ready`.
2. Check the console, Releases: both drafts are listed (Beta 4, Beta 5) with "auto-update ready".

**Part 1 - Beta 3 to Beta 4 (one click):**
1. Ask your friend to keep Clynx open and signed in (Config, Account shows "Connected").
2. In the console, approve and publish **0.3.0-beta.4** (type the version to confirm).
3. Within about two minutes to an hour (Beta 3 checks every 2 minutes after start and then every 6 hours; asking the friend to close and reopen Clynx makes it immediate) their Clynx shows the notice "Clynx 0.3.0-beta.4 is ready to install". They press **Restart and install**. Clynx closes, the installer runs silently, Clynx reopens by itself.
4. Check: Config, Account, Updates says "You have Clynx 0.3.0-beta.4"; their Watches, Database and sign-in are still there; the console Overview shows 1 computer on 0.3.0-beta.4.

**Part 2 - Beta 4 to Beta 5 (no clicks):**
1. Tell your friend only: "leave Clynx open and don't touch it for ten minutes".
2. Publish **0.3.0-beta.5**.
3. Expected: within an hour (their Clynx checks every hour; to see it faster ask them to press **Check for updates**) it downloads the update; when idle it closes and reopens on its own. Nobody clicks anything.
4. Check: Updates shows 0.3.0-beta.5; data intact; console Overview shows the computer on 0.3.0-beta.5.

**Part 3 - a required update (optional):** build a further version, publish it, then press **Require this update (24 hours)**. Ask your friend to set Updates to "Only tell me", and watch the computer update anyway within a day; their Updates screen shows the required-by time.

**Things to watch / what to send me if something looks wrong:** a Windows or antivirus prompt during the install; the Updates screen text; the console Overview version table; Config, Account, "Save a support report". To abort: console, Withdraw the release; to roll back an installed update: Updates, "Go back".

---------------------------------------------------------------------------------------------------------------------------------------------

## 9. Rules followed

Isolated tests and throw-away data only; rollback tag `phase117-start-checkpoint`; no release published; no production record modified (two draft rows added at your request: "prepare any new installer as a signed DRAFT"); signature, checksum, downgrade and rollback checks not weakened; only the Owner can approve, publish, withdraw or require releases.
