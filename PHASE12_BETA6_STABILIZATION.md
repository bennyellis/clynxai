# Clynx Phase 12 - Beta 6 Stabilization

Date: 2026-10-14. Rollback point: git tag `phase12-start-checkpoint`. Final commit `bf26793`. Beta 6 is a **signed DRAFT** on your server; nothing was published and **your real server has not been updated** (that needs your go-ahead, see "Deployment").

## Summary

All five fixes are implemented and tested. The one thing I could not verify is item 4 on a real installer: **the per-user installer rule is built into the Beta 6 installer but not yet proven by an actual install**, because a leftover all-users Clynx registration (from one of my own earlier installer tests) would make any installer show a Windows permission prompt. Uninstall it once (below) and I run the installer test.

## What was changed

| # | Fix | Change | Files |
|---|---|---|---|
| 1 | **F-01** search planner | Owner only (website session). A customer, a plain administrator and a signed-out caller are refused (403 / 401). No app used these routes. | `cloud/src/searchPlanner/routes.ts` |
| 2 | **F-07** Redis outage | A second, fast-failing Redis connection for everything a request waits on (rate limits, spending reservations, health). A command gives up after 1.5 s and a circuit breaker skips Redis for 5 s, so callers use their existing in-memory fallback at once. Queueing an uploaded listing waits at most 2 s; queue counts in health/metrics at most 2 s. The queue's own connection is unchanged. | new `cloud/src/queue/redisGuard.ts`; `security/rateLimit.ts`, `integrations/controls.ts`, `health/routes.ts`, `admin/routes.ts`, `queue/listingProcessingQueue.ts` |
| 3 | **Cloud DELETE 400** | Two-sided: the server now treats an empty body with a JSON content type as "no body" (fixes Beta 2 to 5 computers the moment the server is updated, and their queued deletes then go through); the app no longer sends that content type when it has no body (Beta 6). Everything else about JSON parsing (size limit, prototype-poisoning protection, clear 400 for broken JSON) is Fastify's own parser. | `cloud/src/index.ts`, `billing/routes.ts` (webhook keeps its raw body); `src/main/cloudClient.ts` |
| 4 | **Updates without Windows prompts** | New installer rule: install for the **current user only**, no "all users" page, unless an all-users install already exists on that PC (then it stays all-users so the PC does not end up with two copies; that case still needs permission). | new `build/installer.nsh` (NSIS `customInstallMode`) |
| 5 | **F-06** Postgres restart | The connection pool has an error handler (an idle connection that Postgres closes is logged, not fatal), a 5 s connect timeout, a 30 s idle timeout and a 60 s statement timeout. | `cloud/src/db/client.ts` |

Also: version 0.3.0-beta.6, release notes `release-notes/0.3.0-beta.6.txt`, the Phase 11.6 audit test for F-01 turned from "known defect" into a normal passing test.

## Test results

| Test | Result |
|---|---|
| Cloud server suite | **311 of 311** (was 299; 12 new in `stabilization.test.ts`, planner tests moved to an Owner session) |
| New server tests | DELETE with a JSON content type and no body works for Watch, Product, Feedback and Device (200) and someone else's id still gets 403; broken JSON still 400, poisoned JSON still 400, empty body where one is needed is still a validation 400; billing webhook still gets its raw body; planner refused to customer/admin/signed-out, shown to Owner; Redis failure falls back to memory in under 200 ms and stops asking Redis (breaker); sign-in works with Redis failing; queue wait is capped; `/health/ready` reports Redis down in under 2 s; the pool survives an error event |
| **New app tests** | `cloudDeletes.test.ts` 10 checks: a Watch, Product and Feedback delete send **no content type and no body** against a fake server that behaves like the real one (answers 400 otherwise); requests with a body still say JSON |
| Desktop suite / updates | 49 of 49 files (incl. 103 update checks: unchanged automatic update, required update, resume, withdrawn, rollback logic) |
| Website | 11 of 11 unit; typechecks (app, renderer, server, website) clean |
| **Real Docker outage check** (throw-away stack) | **17 of 17**: DELETE 200; planner 403 for a customer; **Redis stopped**: `/health/ready` 503 fast, sign-in 200 under 3 s, wrong password 401, listing upload stored, AI request answered (refused for lack of a key on the test stack), data calls unaffected, API ready again with no restart; **Postgres stopped**: API alive (not restarted), `/health` 503 fast, sign-in errors fast, **recovered by itself** and the account survived |
| **Real app against that stack** (`t23`, packaged Beta 6) | **20 of 20** (was 18 of 20: the two failures were exactly these defects): offline Watch syncs with no duplicate; database down: API stays up; Redis down: sign-in works; backend restart keeps the session; hard kill reopens with data; whole stack stop/start recovers |
| Sign-in regression (`t22`, final Beta 6 build) | **24 of 24** |
| Worker | Survived the Postgres outage (0 restarts) and processed the listing uploaded while Redis was down |
| Per-user installer (`t26`) | **Not run**: refused to start (safe) because of the leftover all-users registration; see Remaining blockers |

## Beta 6 draft (signed, not published)

| | |
|---|---|
| File | `beta-release\Clynx-Beta-Setup-0.3.0-beta.6.exe`, 124,741,415 bytes |
| SHA-256 | `73a35c32daef1080d3e7bcfb8b848e98b81650d14f2d3691611d8e96bc2ccb47` |
| Built from | clean commit `bf26793`, server address `https://ben.tail0e333d.ts.net` built in |
| Server status | DRAFT with a verified signed update manifest; Beta 2 to 5 untouched and still published |

## Deployment requirements

1. **Update the server (one command, yours to run or approve):** PowerShell in `cloud\deploy\windows`, `.\Update-ClynxLan.ps1`. Backs up first, rolls back by itself if unhealthy, about a minute of downtime. Needed for fixes 1, 2, 3 (server half) and 5. Effects of doing it before publishing Beta 6: your friend's deletes start working, the planner is locked, and a Redis or database outage can no longer freeze or crash the server. No data migration (no schema change).
2. **Publish Beta 6** when you are happy (console, Releases, Approve, type the version). Computers on Beta 4 or 5 then install it by themselves; computers on Beta 2 or 3 need it by hand.
3. **Your development server on port 8787 was rebuilt with these fixes** (its data untouched). Note it is still being used by one of your Clynx instances: it keeps sending heartbeats, eBay searches and product deletes to `127.0.0.1:8787`, which has no eBay key saved. If that instance is meant to use the home server, sign it out and in at `http://10.0.0.81:8788`.
4. If a computer already has an **all-users** install, the Beta 6 installer keeps it all-users and Windows asks permission once more; to get silent updates uninstall and reinstall once (data stays).

## Remaining blockers

1. **Prove fix 4 on a real installer.** Please uninstall the leftover entry: Settings, Apps, **Clynx (beta) 0.3.0-beta.3**, Uninstall, Yes (it points at a throw-away folder from my Phase 11.5 test, `clynx-t21-...`). Then I run `audit\phase12\t26_per_user_install.cjs`: it installs Beta 5, upgrades it with Beta 6 the way the updater does, and does a no-switches install, checking that each finishes by itself, lands in your user area, and writes no all-users registration.
2. **Server not yet updated** (see Deployment 1): until then the fixes are in the draft and on the development server only.
3. **Still open from the Phase 11.6 and Beta 5 reports (not in this phase):** remote AI/Database discovery unproven with a real remote user; the host PC sleeps after 10 minutes, no scheduled backup, Docker may not start after a reboot; the home-network port trusts a forged forwarded address (F-13); testers are not told listings are uploaded (F-20); access tokens live 15 min after logout/disable (F-05); plan limits off and racy (F-08/12); no upload quotas (F-10); shared listings can be overwritten (F-02); password reset impossible (no email); each sign-out adds a device (F-11).
4. Beta 6 is not published and, by your instruction, will not be until you approve.
