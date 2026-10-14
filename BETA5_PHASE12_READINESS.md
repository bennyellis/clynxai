# Clynx Beta 5 - Release Validation and Phase 12 Readiness

Date: 2026-10-14. Scope: a focused re-check using the Phase 11.6 and 11.7 evidence. No feature was added, nothing was published, no product code was changed in this phase.
Evidence tags: `[live]` taken from your real server (its request log and database, read only) - `[auto]` an automated test run now - `[code]` read in the source - `[friend]` needs your friend's PC.

## Verdict

**Ready to start Phase 12 ("operate a real beta"), not ready to invite more testers yet.** The update system is proven end to end on a real remote PC. What stands between you and more testers is a short list of known defects (section 3) and one question the evidence cannot yet answer: **no AI request from a remote user has reached the server since the keys were saved**, so remote AI research and Database discovery are unproven (section 2).

---------------------------------------------------------------------------------------------------------------------------------------------

## 1. Verified working

| Feature | Evidence |
|---|---|
| **Automatic update, Beta 4 to Beta 5, no clicks** | `[live]` Beta 5 was published at 17:54:55 UTC. Your friend's Clynx asked for updates 6 seconds later (17:55:01), downloaded the 119 MB installer, installed, restarted itself and was reporting `0.3.0-beta.5` by 17:58:15: **about 3 minutes 20 seconds from publish to running**, with nobody touching it. |
| Data preserved through the update | `[live]` Same device record before and after (one device, no duplicate); his Watch (1) and Product (1) are still on the server; sign-in survived (token refreshed, heartbeats continue every 30 s); 0 server errors (5xx) in 8 hours. His local Feed and Database files are on his PC and I cannot see them: `[friend]`. |
| Detection, download, signed-and-checksummed install | `[live]` + `[auto]` Verified earlier with real signatures and checksums; the real 119 MB download completed through the tunnel (about 1 MB/s, 107 to 180 s). |
| Update logic (required updates, withdrawn releases, resume, retries, failure recovery, Beta 3 behaviour) | `[auto]` 103 updater checks and three end-to-end scenarios from Phase 11.7 still pass (the code is unchanged). |
| Beta 5 is the same program as Beta 4 | `[auto]` I compared all 626 packed files of the two published installers: only `package.json` and `build-info.json` (the version number) differ. So Beta 5 can have no regression that Beta 4 does not have. |
| Version visibility for the Owner | `[live]` The device list now shows real versions (0.3.0-beta.2, .4, .5). Before Beta 4 every tester showed "unknown". |
| Sign-in, Owner role, invitations, private access | `[auto]` 299 of 299 cloud tests pass (incl. 22 private-access, Owner and admin-boundary tests); your Owner account and the 4 accounts are intact `[live]`. |
| AI and eBay through the shared service (Owner account) | `[live]` OpenAI and eBay keys are saved on the home server and passed their tests; your Clynx got an AI answer (200) and ran **32 eBay searches (all 200)** from your Watch. |
| Feed, Database, Watches, valuation maths (local) | `[auto]` 48 of 48 desktop test files pass (gate, identity, valuation, Watches, scanner state, updates); typechecks clean. Website 11 of 11. |
| Beta 3 sign-in fix | `[auto]` 24 of 24 on the final Beta 4 build (unchanged code in Beta 5). |

---------------------------------------------------------------------------------------------------------------------------------------------

## 2. Remote users: automatic Database discovery and AI research

**What is working:** the server side. Keys are saved and valid; the Owner's AI call and 32 eBay searches succeeded `[live]`; 41 integration tests cover per-person limits, the spending ceiling, abuse blocks and the emergency stop `[auto]`; a signed-in account now defaults to the shared service even if keys are saved on the PC `[code]`.

**What is NOT proven:** that a remote user's Clynx actually asks for AI and gets answers.
- `[live]` The server's usage table shows **one** AI request in total (yours, at 17:34 UTC) and **none** from your friend's account, and no eBay search from his account since the keys were saved (the one he made earlier was refused, 503, before the keys existed).
- His Clynx is syncing normally and uploaded listings at 17:48 and 17:53 UTC, so it is running. No AI calls does not prove a fault: Clynx deliberately spends AI only on core jobs (low-AI mode), and a scan that finds no Search For match asks nothing.
- I cannot tell from here whether his Config says "AI and eBay are provided by Clynx", whether he has a Search For item, or whether Facebook is logged in on his PC.

**Test for his PC (`[friend]`, 10 minutes):** see section 5, test 1. When he does it I check the server's usage table for his account and confirm AI requests with status 200.

**Known caps he will meet:** an ordinary user gets $0.25 of AI a day and 100 eBay calls a day; the whole server $20 a day. If Database discovery on a busy scan uses more, it pauses until tomorrow with a plain message `[code]`.

---------------------------------------------------------------------------------------------------------------------------------------------

## 3. Phase 11.6 findings: what is still open

| Phase 11.6 item | Status now |
|---|---|
| **P0** company AI/eBay keys on the server | **Fixed** `[live]` (saved and tested). Remote use unproven (section 2). |
| **P0 F-01** any user can read all users' search phrases (`/search-planner`) | **OPEN** `[auto]` (the audit test that documents it still fails as expected). |
| **P0 F-07** Redis down makes sign-in, uploads and AI hang | **OPEN** `[code]` (no timeout added). |
| **P0 F-21** host sleep / backups / auto-start | **OPEN** `[live]`: Windows still sleeps after 10 minutes idle; no scheduled backup task exists (backups are only the manual ones, the latest from the update at 13:36); Docker Desktop's own auto-start setting is still off. |
| **P0 F-13** forwarded-address spoofing on the home-network port | **OPEN** `[live]`: a request to `10.0.0.81:8788` with a made-up `X-Forwarded-For` was still logged under the made-up address. |
| **P0 F-20** tell testers their scanned listings are uploaded | **OPEN** (guide unchanged; the upload is still on for everyone). |
| P1 F-06 API/worker crash when Postgres restarts | **OPEN** `[code]` (no pool error handler). |
| P1 F-05 access tokens live 15 min after logout/disable | **OPEN** `[auto]`. |
| P1 F-08/F-12 plan limits off in production; limit race | **OPEN** (`ENFORCE_ENTITLEMENTS=false`). |
| P1 F-10 no upload quotas or retention | **OPEN**. |
| P1 F-02 users can overwrite a shared listing | **OPEN** `[auto]`. |
| P1 F-14 any administrator can publish releases | **FIXED** (Owner only, tested). |
| P1 F-15 email not configured (password reset impossible) | **OPEN** (`SMTP_URL` empty). |
| P1 observability (versions per computer) | **Partly fixed**: version table added. Failed logins, scan failures and uptime alerts still absent. |
| P1 F-11 each sign-out/in adds a device | **OPEN** `[code]`. |

---------------------------------------------------------------------------------------------------------------------------------------------

## 4. Remaining bugs, ranked

**High**
1. **F-01** cross-user search phrases readable by any signed-in user (privacy). Remove or lock the `/search-planner` routes.
2. **F-07** a Redis outage freezes sign-in, listing upload and AI (availability). Needs a timeout on the rate-limit and queue calls.

**Medium**
3. **NEW (found this phase, existed since Phase 2): deleting from the app never reaches the server.** `[live]` Your friend's Clynx sent `DELETE /watches/<id>` **22 times** between 17:40 and 18:23 UTC and the server answered `400` every time. Cause (reproduced `[auto]`): the app sends a JSON content type with no body, which the server refuses ("Body cannot be empty when content-type is set to 'application/json'"). Effect: a Watch (or product/feedback) deleted on one computer stays in the cloud copy, is retried every minute forever, and can come back on another computer or after a re-install. Small fix on the app side (do not send the content type on a delete).
4. **Updates are only silent for a "just for me" install.** `[live]` Your friend was asked a Yes/No by Windows during the Beta 5 update, which is what a per-machine ("all users") install does. The installer lets people choose. Recommend hiding that choice in the installer (Beta 6) or telling testers to choose "Install just for me".
5. **F-21** the home PC sleeps, has no scheduled backup, may not start Docker after a reboot.
6. **F-13** the login/registration rate limits can be bypassed from the home network by anyone who sets a forwarded-address header.
7. **F-06** the API crashes (and Docker restarts it, about 5 seconds) whenever Postgres restarts.
8. **F-05, F-08/F-12, F-10, F-15, F-20** as in the table.

**Low**
9. A command window flashes for about 3 seconds during an update (a built-in wait that pings the PC itself; harmless; can be hidden in the next build).
10. **F-02, F-03, F-04, F-09, F-11, F-16, F-17, F-18, F-19, F-22** unchanged from the Phase 11.6 report.
11. Beta 2 and Beta 3 deleted a half-finished update download if Clynx was opened or restarted within two minutes (Phase 11.7). Fixed in Beta 4; affects only computers still on Beta 2/3 (so far one, now updated).

**Beta 5 regressions: none found.** Beta 5 equals Beta 4 (626 files compared), the server logged no errors after the update, and the only new item above (3) existed before.

---------------------------------------------------------------------------------------------------------------------------------------------

## 5. Tests that need your friend's physical PC

1. **Remote AI and Database discovery (priority).** He opens Config, Account and reads the "AI and eBay" box (it should say Clynx provides them). He adds one Search For product in Database and lets research run for a few minutes. I then check his usage rows: expected AI requests with status 200 and, for an eBay Watch, eBay searches with status 200. Also ask him whether any message says "paused" or "not set up".
2. **eBay Watch from his account.** He creates an eBay Watch (as you did). Expected: eBay searches from his account in the server's usage table, and results in his Watch screen.
3. **Delete test (the bug in 4.3).** He deletes a test Watch, then I look for the 400s in the log. After the fix this should show 200.
4. **Silent update.** He uninstalls Clynx (data stays), reinstalls Beta 5 choosing "Install just for me", then a later release (Beta 6) should install with no Windows prompt.
5. **Closed-app behaviour.** Close Clynx for a night; publish a test release; open Clynx the next day: it should update within a few minutes of opening.
6. **Facebook scan end to end and a phone alert** (ntfy), plus a scan running when an update arrives: the scan stops safely and restarts after the update.
7. **Offline.** Turn his Wi-Fi off for two minutes while Clynx is open: it should keep working and sync again by itself.

---------------------------------------------------------------------------------------------------------------------------------------------

## 6. Ready for Phase 12?

**Yes, to start it.** The update pipeline, which was the hard unknown, works on a real PC. Phase 12 should be the "operate a real beta" plan from the Phase 11.6 report, but it should begin with the items below, because a few small fixes remove the High findings and the one new bug.

**Not yet ready to widen the beta** until: F-01 and F-07 are fixed, the host is set to stay awake and back itself up, and test 1 above proves remote AI works.

## 7. The three highest-priority next actions

1. **Prove remote AI and Database discovery with your friend (test 1 and 2, today).** It is the one major feature with no evidence, it costs nothing to check, and every other plan depends on the answer. If it fails, the cause is in his Config or the server and is quick to find.
2. **Make one small fix release (Beta 6)** that removes the three code defects with the most impact: lock or delete `/search-planner` (F-01), add timeouts so a Redis outage cannot freeze sign-in (F-07), and stop sending a content type on deletes (item 4.3); in the same build make the installer "just for me" only so updates are always silent, and add the Postgres pool error handler (F-06). Each fix is small; F-01, F-07 and F-06 already have tests written in the Phase 11.6 suite (they flip from "known defect" to passing), and the delete fix needs one new test. Beta 6 also gives you a second real, automatic update to watch.
3. **Make the host PC behave like a server (30 minutes, no code):** set Windows sleep to Never while plugged in, turn on "Start Docker Desktop when you sign in", add a nightly backup task (`Backup-ClynxLan.ps1`), and either bind the home-network port to this PC only (the tunnel still works) or accept that anyone on your home network can bypass the login limit. Then reboot once to prove the server comes back by itself.
