# Clynx Phase 11.6 - Remote Beta Readiness Audit

Audit date: 2026-10-14. Build audited: Beta 3 (`0.3.0-beta.3`, commit `16202bd`), server code at the same commit, real server `https://ben.tail0e333d.ts.net` (read-only checks only).
Rollback point: nothing in the product was changed. New files only: `cloud/test/remoteBetaAudit.test.ts` and `audit/phase116/*`.

**How to read the evidence tags.** Every claim says how it was established:
`[code]` read in the source - `[auto]` an automated test I wrote or ran, on throw-away accounts and a throw-away database - `[live-log]` taken from the real server's own request log (what the real remote tester actually did) - `[live-probe]` a harmless unauthenticated GET against the public address - `[sim]` a simulation on a throw-away Docker copy of the stack - `[physical]` needs the remote tester or a real reboot (listed in section 10, NOT done).

---------------------------------------------------------------------------------------------------------------------------------------------

## A. Executive summary

**Can Clynx safely support a few more invited testers today?**
- **Accounts, sign-in, invitations, private access, data isolation and the update channel: yes.** Two-account tests found no way for one signed-in user to read, change or delete another user's Watches, Products, Feedback, Devices or sessions; ordinary users cannot reach any `/admin` route; invitations are single-use and stay required; the public address shows a bare sign-in page to strangers. The real remote tester has been using the system (sign-up, device, Watch and Product sync, 18 listing uploads, update check, 2 installer downloads) without a server error. `[auto][live-log][live-probe]`
- **The features that make money are NOT working for remote testers right now.** The server has no company OpenAI key and no company eBay credentials, so every AI call (5 seen from the real tester) and eBay search (1) was refused with `503`. That means: no AI judging of listings, no photo analysis, no Database research, no Clynx chat, no eBay-based valuation. Scanning and the local deterministic profit maths still run. This is a configuration gap, not a bug, but without it "remote beta" tests only scanning. `[live-log][sim]`
- **Two code defects should be fixed before inviting more people** (both are small): any signed-in user can read every other user's search phrases (`F-01`), and a Redis outage makes sign-in, listing upload and AI hang forever (`F-07`).
- **The host PC is the single point of failure and is not yet set up as a server:** it is configured to go to sleep after 10 minutes idle, there is no scheduled backup, Docker Desktop auto-start is unclear, and the API process crashes (and relies on Docker restarting it) whenever Postgres restarts. `[code][live-probe][sim]`

**Most serious blockers (in order):** (1) company AI/eBay credentials missing; (2) F-01 cross-user search-phrase disclosure; (3) F-07 Redis outage hangs sign-in/upload; (4) host sleep/backup/auto-start; (5) the API port is also open on the home network with "trust the forwarded address" turned on, which lets anyone on that network dodge the login rate limit (F-13); (6) testers are not told that every scanned listing is uploaded to the host (F-20).

**Overall verdict:** *Ready for a small, trusted, invited group to test scanning, Watches, sync and updates. Not ready for "multiple subscribers": valuation is unavailable, abuse limits are partly switched off, and operations (uptime, backups, monitoring) are not production grade.* No Critical finding.

Totals: 0 Critical, 2 High, 10 Medium, 9 Low, 1 test defect.

---------------------------------------------------------------------------------------------------------------------------------------------

## B. Feature readiness matrix (remote installation = a second Windows PC, no Docker/Tailscale)

| Feature | Status | Evidence / what is missing |
|---|---|---|
| Private website, invitation sign-up, download page | **Fully functional** | Real tester used all of it `[live-log]`; 22 private-access tests + gate probes `[auto]`; strangers get `401` on every path except `/health`, `/server/info`, `/robots.txt`, `/gate` `[live-probe]` |
| Desktop install, first start | **Fully functional** | Real tester installed and signed in `[live-log]`; clean-profile start 0.6 s `[auto]` |
| Sign-in / sign-out / restart keeps session | **Fully functional** | Real `login`/`refresh` calls succeeded `[live-log]`; 24/24 clean-install tests `[auto]` |
| Scanning (Feed) | **Partially functional** | Runs on the tester's PC with their Chrome/Edge and their own Facebook login (no dependency on the host or a dev path: no developer paths or addresses in `src` `[code]`). The real tester's PC produced 103 uploaded listings `[live-log]`. **AI judgement is unavailable** (no key), so listings come back "not judged" and only deterministic matches can alert `[code][live-log]`. Needs `[physical]` check of what the Feed screen shows. |
| Database (products, identity, comps) | **Partially functional** | Stored in the PC's own SQLite (source of truth) and mirrored per user to the server (`user_products`) `[code][auto]`. Identity/valuation safeguards are local code identical to the dev build (unit tests pass). AI research and eBay comps are unavailable without keys. Product images and Config are not synced. |
| Watch - create / edit / sync | **Fully functional** | Real tester's Watch reached the server `[live-log]`; offline-created Watch synced later with no duplicate `[sim]` |
| Watch - actually running | **Local-only** | The scheduler lives inside the desktop app (`watchScheduler.ts`, 45 s poll) and needs a logged-in Facebook account in Clynx on that PC. **Watches do not run when the app is closed**, and nothing runs in the cloud `[code]`. |
| Alerts | **Local-only / Not verified** | Sent from the tester's PC straight to ntfy.sh with the tester's own topic (default empty = off) `[code]`. Delivery to a real phone `[physical]`. |
| Valuation / profit maths | **Partially functional** | Deterministic maths works locally; AI + eBay inputs are unavailable now (503) `[live-log]`. Failures are safe: a failed AI call yields "not a deal / not judged", never an invented profit `[code]`. |
| Clynx chat, photo analysis, product research | **Not functional until keys are set** | Same 503s. |
| Own API keys on the tester's PC | **Fully functional** (alternative to the company key) | `aiSource=own`; stored in plain text unless "Protect my saved keys" is turned on `[code]` |
| Local mode (no account) | **Fully functional** | Preserved through the Beta 3 migration `[auto]` |
| Automatic updates | **Partially functional** | Signed channel, no-downgrade, rollback, failure cases covered by 90 unit checks `[auto]`; real tester fetched `/updates/beta/latest` `[live-log]`. An actual in-place update on a second PC is `[physical]`. |
| Installer download over the tunnel | **Fully functional, slow** | 2 downloads completed, 56 s and 70 s for 119 MB (about 2 MB/s) `[live-log]` |
| Password reset / email verification | **Not functional** | `SMTP_URL` is empty: emails are captured, not sent `[code]`. A tester who forgets their password cannot recover it themselves. |
| Billing, subscriptions, plan limits | **Not implemented in production** | No Stripe configured; `ENFORCE_ENTITLEMENTS=false` on the real server, so plan limits are not applied at all `[code]` (dollar and concurrency caps still are) |
| Cloud-operated scanning / server-side Watches | **Not implemented** | The cloud worker is a stub (100 ms sleep per listing) `[code]` |
| Settings sync across a user's PCs | **Not implemented** | Only Watches, Products, Feedback, Listings sync |
| Connecting a user's own eBay account | **Not verified** | Needs an eBay "RuName" that is not configured |
| Mac / mobile | **Not implemented / deferred** | Phase 10 deferred |

---------------------------------------------------------------------------------------------------------------------------------------------

## C. Security findings

Severity is for the *current* deployment (private, invitation-only, a handful of testers) unless stated.

### High

**F-01 - Any signed-in user can read every other user's search phrases and Watch ids, and trigger a full-table scan** (High)
- Evidence `[auto]`: `cloud/test/remoteBetaAudit.test.ts` ("KNOWN ISSUE F-01"): user B called `POST /search-planner/aggregate` then `GET /search-planner/demand` and received user A's unique private phrase and A's Watch ids (`audit/phase116/F01_search_planner_leak.txt`). Each POST also inserts one row per distinct phrase into `search_demand_snapshots` forever, and scans every user's Watches synchronously. No client uses these routes `[code]` (`grep` over `src` and `website/src`: none).
- Files: `cloud/src/searchPlanner/routes.ts`, `service.ts`, `aggregate.ts`.
- Fix: remove the routes, or make them Owner-only; if kept, never return `sampleWatchIds`, only show phrases with at least N distinct users, and run on a schedule instead of on request.

**F-07 - When Redis is down, sign-in, listing upload, AI calls and `/health/ready` hang forever** (High, availability)
- Evidence `[sim]`: with the test stack's Redis stopped, `/auth/login`, `/listings/ingest`, `/ai/chat/completions` and `/health/ready` did not answer within the 8 s test limit, while `/health`, `/watches` and `/server/info` answered in under 20 ms (`audit/phase116/F07_redis_down_endpoints.txt`). In the packaged-app test the same sign-in request (made with curl) also gave up after 20 s, twice. Redis came back and queued requests completed with no restart.
- Cause `[code]`: the shared Redis connection uses `maxRetriesPerRequest: null`, so a command never fails while Redis is unreachable. `security/rateLimit.ts` only falls back to memory when the command *throws*, which never happens. The comment promising degradation to per-process limits is therefore untrue.
- Files: `cloud/src/queue/connection.ts`, `cloud/src/security/rateLimit.ts`, `cloud/src/integrations/controls.ts`, `cloud/src/queue/listingProcessingQueue.ts`.
- Fix: use a second Redis connection for rate limiting with a short `commandTimeout`/`enableOfflineQueue:false` so the existing fallback works; wrap the enqueue in a timeout so ingest never waits on the queue.

### Medium

**F-02 - Any user can overwrite a shared listing record** (Medium; High if the shared table is ever used for valuation or shown to others)
- Evidence `[auto]` ("KNOWN ISSUE F-02"): B ingested the same `(source, sourceListingId)` as A and replaced A's title/price/url. `listings` is one global table keyed by listing id; nothing records who owns a version. Today no endpoint returns listing content to other users (only `/listings/lookup` and `/listings/:id/jobs`), so there is no read-back contamination of valuations `[auto][code]`.
- Files: `cloud/src/listings/routes.ts`. Fix: store per-user observations (or keep the first writer's row and add a `user_listings` table), before any "General Discovery"/cross-user feature is built.

**F-05 - Access tokens keep working after logout, password change, account disable and account deletion (up to 15 minutes)** (Medium)
- Evidence `[auto]`: after logout the access token answered `200` (`F05_access_token_after_logout.txt`); a disabled user's existing token answered `200` (`F05_disabled_user_access_token.txt`, "KNOWN ISSUE F-05"). Refresh is correctly stopped in every case. A deleted account's token returned `500` on writes (a foreign-key error, generic message) and `200` empty on reads (`F09_deleted_account_token.txt`).
- Cause: `requireAuth` verifies the JWT signature only; it never checks that the user still exists/enabled `[code]`. Files: `cloud/src/auth/middleware.ts`.
- Fix: one indexed `SELECT disabled_at FROM users WHERE id=$1` (cached 5-10 s) per request, or shorten the token life.

**F-06 - The API and worker crash whenever Postgres restarts** (Medium, reliability)
- Evidence `[sim]`: stopping Postgres killed the API (`Unhandled 'error' event ... terminating connection due to administrator command`); `/health` returned connection-refused, not `503`; Docker's restart policy brought it back, and it recovered 5.5 s after Postgres returned. Data survived. `[code]`: `pg.Pool` has no `error` listener and no `connectionTimeoutMillis`.
- Files: `cloud/src/db/client.ts`. Fix: `pool.on("error", ...)`, `connectionTimeoutMillis`, `statement_timeout`.

**F-08 / F-12 - Plan limits are switched off in production, and the limit check is not atomic** (Medium)
- Evidence: the real server runs `ENFORCE_ENTITLEMENTS=false` `[code]`, so free-plan limits (5 Watches, 2 devices, 150 AI requests/day) are not applied; only the dollar, concurrency and abuse caps are. With enforcement on, a single sequential user is stopped correctly (6th Watch and 3rd device get `402`), but 20 parallel Watch creations by a free user all succeeded (20 stored, limit 5) `[auto]` (`F08_limit_race.txt`, "KNOWN ISSUE F-08"). The forged-webhook, self-upgrade and role-claim attempts all failed `[auto]`.
- Files: `cloud/src/entitlements/enforce.ts`, `watches/routes.ts`, `devices/routes.ts`. Fix: do the count and insert in one transaction under a per-user advisory lock (the refresh-token code already does this); then decide when to enable enforcement.

**F-10 - No per-user quota, size or rate limit on sync and upload endpoints; no retention** (Medium)
- Evidence `[auto]`: one authenticated request carried 2000 listings (accepted, 14.1 s of server time, 2000 jobs queued; `F10_ingest_unbounded.txt`). Only AI and eBay have per-minute limits. Text fields have no length cap `[code]`. Stored cost measured at about 0.8 KB per listing plus 0.24 KB for its job row (173,951 listings = 133 MB + 41 MB) `[sim]`; nothing is ever deleted. Every new listing queues a no-op stub job `[code]`.
- Fix: cap the batch (about 100), add per-user request/day budgets and field lengths, drop the stub job, add retention.

**F-13 - A client-chosen `X-Forwarded-For` is trusted, so the login/registration/invitation-guess limits can be dodged by anyone who reaches the API port directly** (Medium)
- Evidence `[sim][live-probe]`: with `TRUST_PROXY=true`, 12 failed logins with a rotating forwarded address were never throttled (twelve `401`), while the same address was locked after 8 (`429`). The real server's home-network port (`10.0.0.81:8788`) honoured a spoofed header (logged address became the one I sent). The one test through the public tunnel (from this host) did not honour it, so the tunnel looks safe, but I could not prove that for outside clients.
- Files: `cloud/src/config.ts` (`TRUST_PROXY` is a boolean), `cloud/docker-compose.lan.yml`. Fix: publish the API port on `127.0.0.1` only when a tunnel is used (Funnel connects locally), and trust only the first hop.

**F-14 - Any "admin" (not only the Owner) can approve and publish releases and attach update manifests** (Medium)
- `[code]` `cloud/src/admin/routes.ts`: `/admin/releases/*` use `requireAdmin`. The signed-manifest check protects in-app updates (an admin cannot forge the offline-key signature), but not the website installer download. Only one admin (the Owner) exists today. Fix: `requireOwner` for approve/publish/withdraw/upload.

**F-15 - Email is not configured, so password reset and email verification do nothing** (Medium, operations)
- `[code]` `SMTP_URL` empty on the real server; mail is "captured only". Testers cannot recover a password; the Owner has no "set temporary password" tool (`[code]` scripts: `admin`, `owner`, `invite` only). Fix: configure SMTP, or add an Owner reset-link tool.

**F-20 - Every scanned listing from every tester is uploaded to the host, and testers are not told** (Medium, privacy)
- `[code][live-log]`: `listingIngestSync.ts` pushes every scanned listing (title, description, price, URL, image URLs, seller name, location) every minute with no per-user opt-out; the real tester produced 18 uploads / 103 rows. The Owner can read them in Postgres. The tester guides do not mention it (`grep` of `PRIVATE_BETA_GUIDE.md`, `BETA2_INSTALL_GUIDE.md`). Fix: tell testers, add an opt-out toggle, and add a retention limit.

**F-21 - The host is not set up like a server** (Medium, availability) `[code][live-probe]`
- Windows is set to sleep after 600 s idle on AC (High performance plan, `STANDBYIDLE=0x258`); no scheduled backup (three manual backups exist, the last at 00:03); Docker Desktop's own setting says auto-start is off (`settings-store.json`) while an HKCU Run entry exists, so after a reboot the server may stay down until you sign in and start Docker; the Funnel entry persistence was not tested. Fix: sleep = never, Docker auto-start on, a nightly `Backup-ClynxLan.ps1` task, and a real reboot test.

### Low

- **F-03** `403` for "exists but not yours" vs `404` for "does not exist" on Watch/Product ids lets a user test whether an id exists (`[auto]`, ids are random UUIDs, so this is a very small leak). Same status for both fixes it.
- **F-04** `/listings/lookup` and `/listings/:id/jobs` tell any user that some user has scanned a given listing id `[auto]`.
- **F-09** see F-05 (deleted-account token yields `500` on write).
- **F-11** Signing out clears the stored device id and never removes the old device; every sign-out + sign-in registers another device `[code][sim]` (devices = 2 after one cycle). With limits on (2 free devices) the third sign-in on the same PC would get `402`. Fix: remove the device on sign-out or keep a per-PC id.
- **F-16** Password policy is 8 characters minimum, no breach or complexity check `[code]`.
- **F-17** Refresh tokens are not tied to a machine: a token created for one device still refreshes when another device id is named, or none `[auto]` (`F06_refresh_not_machine_bound.txt`). Mitigated by 30-day life, rotation, and revoke-all on reuse, which was verified, including that user B is untouched `[auto]`.
- **F-18** Local OpenAI/eBay keys are plain text in `.env` unless the tester turns on "Protect my saved keys"; the refresh token falls back to plain text silently if Windows encryption is unavailable `[code]`.
- **F-19** Secret-bearing, git-ignored files (`.env`, `cloud/.env*`) and `data/` live inside a OneDrive-synced folder, so Microsoft's cloud holds copies `[code]`. No secret is tracked in git (only the public update key) `[code]`.
- **F-22** Request URLs, including query strings such as `?token=` on emailed links, appear in server logs `[code]` (none found in the current log: `0` matches).

### Test defect
- **T-01** `cloud/test/integrations.test.ts` "a tampered or foreign ciphertext" is flaky: it replaces the last base64 character with `x`, which sometimes decodes to the same bytes. It failed in 2 of 3 full runs here and passed 6 of 6 when run alone. Product behaviour is fine. Fix: flip a character in the middle.

### Verified secure (no finding)
- Authorization on all 112 routes: 85 refuse anonymous callers; the remaining 27 are intended public routes or validation errors (`audit/phase116/anonymous_route_probe.txt`). An ordinary user (bearer and website cookie) was refused by every `/admin` route including URL variants (`//admin/invites`, `/ADMIN/invites`, `%2e%2e`); a plain administrator was refused by Owner-only integration routes `[auto]`.
- Registration cannot claim a role/plan (`role=owner`, `plan=pro` in the body were ignored); billing webhooks need a valid signature; no endpoint accepts a plan `[auto]`.
- Refresh tokens: random 256-bit, stored hashed, rotated in a locked transaction, reuse revokes the user's family only, device removal and password change end sessions `[auto][code]`. Forged, wrong-key, `alg:none`, expired and refresh-secret tokens are refused `[auto]`.
- Invitation codes: 80 bits, stored hashed, claimed atomically, only wrong guesses are counted `[code][auto]`.
- Secrets: company keys encrypted at rest (vault), write-only, never returned; the AI proxy allow-lists models, clamps output, reserves worst-case cost before the call, caps concurrency, blocks abuse bursts `[code][auto]`. One noisy user's 300 AI requests did not slow another user's calls (quiet user p95 15 ms) `[sim]`.
- Network exposure: only `10.0.0.81:8788` (gated) and the tunnel are reachable; Postgres/Redis of the real stack publish no ports; the developer stack's Postgres/Redis/API are bound to `127.0.0.1` only `[live-probe]` (`docker ps`, `netstat`). 23 sensitive paths probed on the public address (`/admin/*`, `/watches`, `/me`, `/releases`, `/.env`, `/metrics` ...) all returned `401`; security headers present (HSTS, CSP `default-src 'none'`, `X-Frame-Options: DENY`, `noindex`, `no-store`) `[live-probe]`.
- Electron: `contextIsolation`, `sandbox`, no node integration, IPC accepted only from the app's own page, permissions denied, external links limited to http(s) `[code]`. Update signing: Ed25519, SHA-512 + SHA-256, no downgrade, bearer sent only to the signed-in server `[code][auto]`.
- Error messages: unexpected errors return a generic body and are logged server-side only; login errors do not reveal whether an email exists `[code][auto]`.
- One unknown third party fetched `/robots.txt` on the public address `[live-log]` - expected for any public host name.

---------------------------------------------------------------------------------------------------------------------------------------------

## D. Performance findings

All server numbers: a throw-away copy of the production stack (API 512 MB limit, Postgres, Redis) on this PC, Docker with 12 CPUs / 16 GB, traffic from the same PC. They measure the software, not your internet connection. `[sim]`. Third-party services were never called (no AI, eBay or Facebook traffic).

### Measured

| Measurement | Result |
|---|---|
| Sign-in (password hash) | p50 66 ms, p95 74 ms (one user); refresh 10 ms |
| 25 sign-ups at the same instant | 1.1 s wall time; API CPU peak 784 % (all cores), RAM peak 289 MiB of 512 MiB |
| 25 sign-ins at the same instant | 1.0 s wall; p95 0.96 s |
| Sync reads (watches/products/feedback) | 5 ms p50 at 1 user, 8.8 ms p95 at 10 users, 18.7 ms p95 at 25 users |
| Listing upload, 50 per request | p95 290 ms (2 users), 425 ms (5), 457 ms (10), 1,121 ms (25) |
| Throughput, closed loop, no think time | 48.5 req/s (2 users), 97 (5), 162 (10), 170 (25): **saturates near 165 req/s**; about 1,200 listings/s; API at about 100 % of one core, Postgres about 160 % |
| Errors during all load levels | 0 |
| Refusal path of the AI gate (no key) | 23 ms p50, 52 ms p95 for 300 requests; real tester's 503s averaged 37 ms `[live-log]` |
| Real remote tester load | 113 sync/upload/AI requests in 45 minutes = **2.5 requests/min** (including 18 uploads of up to 50 listings) `[live-log]` |
| Real request latency seen from the tester | sync GETs 4-5 ms, uploads 118 ms avg (819 max), heartbeat 84 ms avg `[live-log]` |
| Installer download over the tunnel | 119 MB in 56 s and 70 s (about 2 MB/s) `[live-log]` |
| Desktop cold start to first screen | median 0.59 s (5 runs: 0.56-0.61 s) `[auto]` |
| Desktop signed-in start to main screen | median 0.70 s (5 runs: 0.65-0.78 s) |
| Register click to app ready / sign-in click to ready | 0.46 s / 0.16 s |
| Desktop memory and CPU (idle, signed in, no scan) | 613 MB working set (355 MB private) across 5 processes; CPU about 0 % |
| Local database (SQLite), Feed page of 200 | 6.6 ms @ 1,000 listings, 32 ms @ 10,000, **129 ms @ 50,000** (deep page 207 ms) |
| Local database, single listing by id | 1.3 ms @ 1,000, 9.7 ms @ 10,000, **23 ms @ 50,000** (should be constant; grows with size) |
| Local database, product match / unsynced batch | 25 ms and 16 ms @ 50,000 listings; insert about 4 ms per listing; file 13.6 MB per 50,000 |
| Server storage per uploaded listing | about 0.8 KB + 0.24 KB job row |

### Bottlenecks
1. One Node process on one core is the API ceiling (about 165 req/s). Postgres is next. This is far above what testers generate.
2. Password hashing bursts: 25 simultaneous sign-ups use every core and 289 MiB; a few hundred at once could hit the 512 MB container limit.
3. The tunnel and the home uplink: the installer takes about a minute per tester; 25 simultaneous downloads share one uplink (not measured).
4. Local Feed queries grow roughly linearly with stored listings (F-perf, P2).
5. AI budget: global `$20/day` and `$200/month`, free users `$0.25/day`, 3 concurrent AI calls per user, 20 overall `[live DB]` - the real limit for a crowd.

### Practical capacity (estimates, labelled)
- *Estimate from the two measurements above:* the API could carry about 165 / (2.5 ÷ 60) = roughly 4,000 users scanning continuously at today's behaviour. That is a mathematical ceiling for the API alone and is **not** a promise: bursts, the host PC, the uplink, and Postgres growth come first.
- *Estimate:* uploads at about 1 KB per listing; a tester scanning continuously produced about 130 listings per hour, so 25 always-on testers add about 85 MB per day (2.5 GB per month) with no retention.
- *Estimate:* AI spend, using $0.25 per free user per day, reaches the $20 global daily cap at 80 free users if all of them use their full allowance.
- *Not measured:* AI valuation latency (needs paid calls), Feed/Watch behaviour with a live Facebook session, Chrome's memory during scans, behaviour of 25 real PCs. 2/5/10/25-user results above are simulated users on one machine.

---------------------------------------------------------------------------------------------------------------------------------------------

## E. Architecture findings

**What runs where** `[code]`
- *On the user's computer:* the Electron app, the React screens, the local SQLite database (the source of truth), Facebook scanning through the user's own Chrome/Edge and Facebook login, the Watch scheduler, ranking/gate/profit maths, product identity, alerts to ntfy, bundle breakdown, WatchCount comps scraping, web research.
- *On the host PC:* Fastify API, Postgres (accounts, devices, a mirror of Watches/Products/Feedback, all uploaded listings, usage and audit), Redis (rate limits, spend reservations, queue), a worker that only runs a stub, the website, release files, the OpenAI/eBay proxies, the Tailscale Funnel.
- *Needs the host online:* sign-in and registration, sync, listing upload, the shared AI/eBay proxies, update checks and installer downloads, the website. *Keeps working without the host:* scanning, the local Feed, Database, Watches, alerts (measured: Watch creation, offline mode, reconnect with no duplicates `[sim]`).
- *Developer-specific dependencies:* none found in the app (no `C:\Users\biggt`, no `10.0.0.81`, no `localhost:8787` outside the dev-only default) `[code]`. The host depends on: this PC's Docker Desktop, `C:\Users\biggt\ClynxLan\.env.lan`, the offline update-signing key on this PC, the Tailscale account.
- *Shared between users:* Postgres, Redis, the OpenAI and eBay keys and budgets, the `listings` table, the tunnel and uplink.
- *Not shared:* every user's Watches, Products, Feedback, devices, sessions and local database (`user_id` on every query `[auto]`).

**What happens when many users scan at once:** each scan is on its own PC and its own Facebook session/IP; the host only receives uploads (measured above) and AI/eBay calls (rate limited per user, 3 concurrent, dollar caps). Nothing queues on the host except the no-op listing jobs.

**Remaining local dependencies a tester must satisfy:** Windows 10/11, Google Chrome or Microsoft Edge, their own Facebook account logged in inside Clynx, the ntfy app on their phone for alerts, internet access to the host address.

**Requirements for cloud-operated scanning (not started):**
1. A scanning worker pool with its own browser profiles and per-account session storage; Facebook login/2FA/checkpoint handling and ban risk (today each tester's own account and IP carry that risk).
2. A durable job scheduler (Postgres-backed) with per-user concurrency, per-account cooldowns, back-pressure and dead-letter handling; the current worker is a stub.
3. Server-side copies of the gate, valuation and product-identity code (currently desktop-only) and a per-user data model for listings (see F-02).
4. A notification service (ntfy/email/push) owned by the server, with per-user topics and delivery tracking.
5. Proxy/IP strategy, compliance review of Marketplace terms, monitoring, and a real hosting environment (not a home PC).

---------------------------------------------------------------------------------------------------------------------------------------------

## F. Reliability results (throw-away stack + packaged app; `audit/phase116/t23_result.log`, 18 of 20 checks pass, the 2 failures are F-06 and F-07 written as "secure behaviour" checks)

| Situation | Result | Data-loss / duplicates / stalls |
|---|---|---|
| Server stopped (API down) | App noticed within seconds, stayed open and signed in, a new Watch was created locally; after restart (1.5 s to healthy) it synced in about 105 s; app online again | none; exactly 2 Watches on the server, no duplicate |
| Internet drop | Same code path as "server unreachable" (timeouts become offline) `[code]`; the physical test is in section 10 | - |
| Backend restart | App stays signed in and reconnects (tokens survive restarts) | none |
| Postgres stopped | **API process crashes** (F-06); Docker restarts it; recovered 5.5 s after Postgres returned; app stayed up | data intact |
| Redis stopped | **Sign-in, upload, AI and readiness hang** (F-07); everything resumed when Redis returned | in-flight requests wait; the desktop treats them as offline |
| Request timeout | By design a failed or slow request makes the desktop treat the server as offline and retry on the next sync tick `[code]`; the app's own timeout value was not separately measured | none seen |
| Authentication expires | Refresh works (2 real `/auth/refresh` calls succeeded `[live-log]`); invalid refresh sends the user to sign-in `[auto]`. A deliberate 15-minute-wait test was not run. | none |
| Desktop crash (hard kill mid-session) | Reopens in 0.73 s, still signed in, local Watches intact; nothing duplicated after the next sync | none |
| Scan interrupted | **Not verified live** (needs a Facebook session). Existing unit suite covers scanner state and error classes (`scannerState`, `scannerErrors`: passing). | - |
| Whole stack stopped and started (host restart simulation) | Ready in 11 s, data intact, app reconnected by itself. A real Windows reboot is `[physical]` and F-21 predicts the server stays down until Docker starts. | none |
| Automatic update fails | Covered by 90 checks (bad signature, bad hash, download cut, installer won't start, new version won't start -> rollback) `[auto]` | none |
| Misleading profitability | A failed or missing AI/eBay answer produces "not judged"/"not a deal" and never a profit figure `[code]`; one unexplained case below | - |

**Unexplained observation (honest note):** in one of four runs of the reliability test the app's window closed during the "database stopped" step and the offline catch-up exceeded its 180 s wait. The next two runs did not reproduce it and the earlier run did not capture the app's output. I could not determine the cause (it may be my harness). It is listed under P1 to investigate with the remote tester.

---------------------------------------------------------------------------------------------------------------------------------------------

## G. Observability - what the Owner can and cannot see today

| Question | Today | Gap |
|---|---|---|
| Active users, registered devices | Console overview: users, verified, sign-ups/day, devices; per-user device list with last-seen `[code]` | no "active in last 24 h" number |
| Failed login attempts | **Not recorded** (only a Redis counter and a request-log `401`) | no list or alert |
| Failed scans | **Not visible** (scans are local; only a pasted support report) | no telemetry |
| Background worker failures | Queue counts on `/admin/health` and `/metrics`; the worker does nothing real | - |
| Watch job failures | **Not visible** (Watches run on the PCs) | no telemetry |
| API errors | counters: total requests, 5xx count | no per-route or per-user breakdown |
| Slow requests | **Not measured** by the server (pino logs have `responseTime` per request) | no histogram |
| Unhealthy services | `/health`, `/health/ready` (database, Redis), console health | no alert if it goes down; no host-level check |
| Resource exhaustion | AI spend, eBay calls and abuse flags are visible and capped `[code]` | no disk/RAM/Postgres-size/queue-growth warning |

**Practical improvements (small):** (1) a nightly Windows scheduled task that runs `Get-ClynxLanStatus.ps1`, checks `https://ben.tail0e333d.ts.net/health/ready` and shows a notification or sends an ntfy message when it fails; (2) log failed logins to a small `auth_events` table and show the last 24 h in the console; (3) log the 5 slowest request routes per hour from the existing pino lines; (4) a daily report of database size, listing count, queue depth and disk free; (5) an optional anonymous "scan health" ping from the desktop (last scan result, error class, app version) with the same opt-out as F-20; (6) a console "last seen > 3 days" filter on devices.

---------------------------------------------------------------------------------------------------------------------------------------------

## H. Regression verification (Beta 3 fix did not break anything)

| Suite | Result |
|---|---|
| Cloud server, all tests | **291 / 291 pass** (265 existing + 26 new) on the final run; one flaky test seen earlier (T-01) |
| Desktop unit tests | **48 / 48 files pass**; typecheck main + renderer clean |
| Website unit tests | 11 / 11 pass (the browser E2E suite was not re-run: no website code changed) |
| Beta 3 clean-install authentication (packaged app, Beta-1 style leftover profile, invitation sign-up, sign-out/in, restart) | **24 / 24 pass** (`audit/phase116/t22_regression.log`) incl. a read-only "Test connection" to the real address |
| Existing accounts, Owner, invitations, private access, update delivery | Cloud suites `owner`, `privateAccess` (22), `updates`, `auth`, `devices`, `watches`, `products`, `feedback` all green; the real server still has 4 accounts, 1 Owner, Beta 2 and Beta 3 both published (no change by me) `[live DB read]`; the real tester's `/updates/beta/latest` returned `200` |
| Local mode, Feed/Database/Watch/valuation | Local mode kept through migration (t22 S2); the desktop unit suite covers gate, identity, valuation maths, watches, scanner state |
| NOT re-run | Installer-based end-to-end (`t21`): blocked because a per-machine "Clynx (beta) 0.3.0-beta.3" uninstall entry still exists in `HKLM` and would raise an administrator prompt on your screen. Uninstalling it (Settings > Apps) allows the full cycle to be re-run. |

I changed no product code. The suite counts include the new `cloud/test/remoteBetaAudit.test.ts`, which writes evidence files to `audit/phase116/` and removes its own queue backlog.

---------------------------------------------------------------------------------------------------------------------------------------------

## I. What I did and did not do (execution rules)

- Used only throw-away accounts, the disposable test database (`clynx_cloud_test`, Redis db 9) and a disposable Docker copy of the stack (created and removed again, including its volumes and image). No real account, record or subscription was modified. The real server received about 30 harmless unauthenticated `GET`s and read-only SQL aggregates. No release was published or changed, the tunnel was not touched, no destructive migration was run.
- No security test was run against the public address beyond those GETs (no brute force, no load, no write).
- Facebook, OpenAI, eBay and WatchCount were never contacted.
- Own mistakes: my first bulk-ingest test left about 6,000 queued jobs in the shared test Redis, which made two later queue tests time out; I cleaned it and made the test clean up after itself. My first load test sent a JSON content type with an empty body and recorded false `400`s; fixed and re-run. My reliability test aborted once leaving the test Postgres stopped; I restarted it. Temporary test folders were deleted.

---------------------------------------------------------------------------------------------------------------------------------------------

## J. Prioritized remediation plan

**P0 - before inviting more testers**
1. *(Owner, no code)* Decide on valuation: either add the company OpenAI key (and eBay credentials) in the console with the existing spend caps, or tell testers that AI/valuation features are off and that they may use their own key. Re-test with the remote tester.
2. *(code, small)* F-01: remove or Owner-lock `/search-planner/*`.
3. *(code, small)* F-07: give rate limiting and ingest a Redis path that fails fast.
4. *(host, no code)* F-21: sleep = never, Docker Desktop auto-start, a nightly backup task, and confirm after a real reboot that the site comes back (see section 10).
5. *(host, no code)* F-13: bind the API's home-network port to localhost only while the tunnel is in use (or accept that anyone on your home network can bypass the login limit).
6. *(docs)* F-20: add a line to the tester guide: every scanned listing is uploaded to the host.

**P1 - before a broader beta**
7. F-06: `pool.on("error")`, connection and statement timeouts; investigate the "unexplained observation" with the remote tester.
8. F-05: check the user is still enabled on each request (cached), or shorten the token life.
9. F-08/F-12: atomic limit checks; set a date to switch `ENFORCE_ENTITLEMENTS` on after testing with two real accounts.
10. F-10: cap upload batches (about 100), field lengths and per-user request budgets; retention for `listings` and `listing_processing_jobs`; drop the no-op job.
11. F-02: per-user listing observations before any cross-user feature.
12. F-14: Owner-only release actions; F-15: configure SMTP or add an Owner reset tool.
13. Observability items 1-4 in section G.
14. F-11: remove the device on sign-out; F-03: same status for "not found" and "not yours".

**P2 - later**
15. F-16 password policy/breach check, F-17 machine-bound refresh tokens, F-18 default-on key protection, F-19 move secrets out of OneDrive, F-22 scrub query strings from logs, T-01 fix the flaky test.
16. Local database: make `getById` constant-time and paginate the Feed query so 50,000-listing profiles stay fast.
17. Server-side scan telemetry (opt-in), per-user listing model, hosted environment instead of a home PC.

---------------------------------------------------------------------------------------------------------------------------------------------

## K. Phase 12 recommendation

**Focus: "Operate a real beta" - make the existing remote model dependable and safe; add no new product features.**
1. Close every P0 and P1 item above.
2. Turn the host into a managed service: restart-safe Docker, scheduled backup with a restore drill, uptime check with an alert to the Owner's phone, monthly secret rotation using the existing script.
3. Switch on and prove entitlements with at least two real accounts and a small AI budget; bring valuation online for testers.
4. Run the section 10 physical tests with 2-3 testers, record the results, and fix what they find.

**Defer:** cloud-operated scanning and server-side Watches, billing activation, mobile/Mac, cross-user "General Discovery", a custom domain.

**Acceptance criteria for Phase 12**
- All P0/P1 items closed and each covered by an automated test (the `it.fails` tests in `cloud/test/remoteBetaAudit.test.ts` flip to passing and are converted to normal tests).
- A real reboot of the host leaves the site reachable within 5 minutes with no one touching it; a restore from last night's backup succeeds on a throw-away stack.
- With Redis or Postgres stopped for 60 s, the API answers (503 or degraded) within 3 s, and recovers by itself with no manual step.
- Two real tester accounts each run a scan, a Watch and an AI valuation concurrently; each sees only their own data; spend per user and globally stays inside the caps; the Owner can see failed logins and worker/health problems in the console.
- A remote PC updates from Beta 3 to the next build in-app, and rolls back after a forced failure.
- Measured (not estimated) capacity statement for 10 real testers, from a 24-hour run.

---------------------------------------------------------------------------------------------------------------------------------------------

## L. Tests that need the remote tester or you (not done)

1. **In-app update on the remote PC** (Beta 3 to the next beta) and a deliberate failure/rollback.
2. **Facebook login inside Clynx on the remote PC, one Feed scan, one Watch cycle, an ntfy alert on their phone**, with the app open, then closed (Watches should stop).
3. **Internet drop on the remote PC** (turn Wi-Fi off 2 minutes, on again): app should show offline, keep working, resync once.
4. **Sleep/wake of the remote PC and of the host**; confirm both recover.
5. **A real host reboot** (you): does Docker, the stack and the Funnel come up by themselves?
6. **A long scan (hours)** on the remote PC: Chrome + Clynx memory/CPU, Feed responsiveness with 10k+ listings.
7. **Installer experience:** SmartScreen/antivirus prompts, uninstall/reinstall keeping data, download time on their connection.
8. **Send me** `%APPDATA%\Clynx\app-settings.json`'s `cloudApiUrl` line and the Windows app version if you still want to confirm what caused the earlier `localhost:8787` failure.
9. **Uninstall the stale per-machine "Clynx (beta)" entry** on this PC (Settings > Apps), then I can re-run the installer-based cycle.

---------------------------------------------------------------------------------------------------------------------------------------------

## M. Evidence index (repository)

- `cloud/test/remoteBetaAudit.test.ts` (26 tests; known defects as `it.fails`)
- `audit/phase116/anonymous_route_probe.txt`, `F01_*.txt` ... `F10_*.txt` (raw evidence)
- `audit/phase116/loadtest.cjs`, `loadtest_result.json` (server load; test stack only)
- `audit/phase116/t23_remote_reliability.cjs`, `t23_result.log`, `t23_measurements.json` (packaged-app timings and failure recovery)
- `audit/phase116/bench_store.ts`, `run_bench_store.cjs`, `bench_store_result.json` (local database)
- `audit/phase116/t22_regression.log` (Beta 3 authentication regression, 24 / 24)
