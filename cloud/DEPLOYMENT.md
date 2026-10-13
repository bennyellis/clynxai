# Clynx Cloud and website — deployment and operations

Nothing in this repository deploys anything or spends money. These are the steps *you* run, on a server you choose, when you decide to.

## What runs
| Service | What | Notes |
|---|---|---|
| `api` | Fastify HTTP API **and the website** (`dist/index.js`) | one process serves the API, the built website (`/`), the customer portal and the admin console on ONE address, so the sign-in cookie is same-origin. Run 1+ copies behind a TLS reverse proxy |
| `worker` | BullMQ worker (`dist/worker.js`) | processes queued jobs; retries with exponential backoff (5 attempts) |
| `postgres` | PostgreSQL 16 | the durable state: accounts, subscriptions, releases metadata, **the encrypted credential vault** |
| `redis` | Redis 7 (AOF on) | job queue, rate-limit counters, spending reservations |
| volume `releases_data` | uploaded installers (`/data/releases`) | back it up with the database |

`docker-compose.yml` is the **local dev** stack. `docker-compose.prod.yml` is the production-shaped one (no published DB/Redis ports, secrets from the environment, health checks, memory limits, `NODE_ENV=production`). Both build from the **repository root** (`docker build -f cloud/Dockerfile .`), because the image also builds the website.

## Local development (no Docker needed for the code)
```
cd cloud && cp .env.example .env          # fill in the two JWT secrets; the rest has development defaults
docker compose up -d postgres redis        # or any Postgres 16 + Redis 7 you already have
npm ci && npm run migrate && npm run dev   # API on :8787
cd ../website && npm ci && npm run dev     # website on :5180, forwarding API calls to :8787 (one origin for the browser)
```
A self-contained preview with sample accounts and a simulated payment provider: `cd cloud && npm run preview:db && npm run preview:seed && npm run preview:web` (needs `.env.preview`, see `.env.preview.example`). Everything in it is simulated; no email is sent and no payment provider is contacted.

## First deployment (a single server with Docker)
1. `cp .env.prod.example .env.prod`, then fill in every blank that applies. Generate secrets with `openssl rand -hex 32`; the credential vault key with `openssl rand -base64 32` (never reuse the dev defaults). Set `PUBLIC_URL` to the https address customers will use.
   Blank values are treated as "not set".
2. `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build`. Migrations run automatically at API start (idempotent; guarded by a Postgres advisory lock so two copies starting together are safe).
3. Put a TLS reverse proxy in front of `127.0.0.1:8787` — `Caddyfile.example` is a ready-made one (automatic certificates). The API sets `TRUST_PROXY=true` in the prod compose so rate limits use the real client IP. Do **not** expose port 8787 publicly without TLS. With an https `PUBLIC_URL` the API sends `Secure` / `__Host-` cookies and HSTS.
4. **Create the Owner** (once, on the server — there is no public way to become Owner):
   ```
   # 1. register normally on the website with the address that will be the Owner (and verify it)
   docker compose -f docker-compose.prod.yml exec api node dist/scripts/owner.js begin you@your-domain.example
   docker compose -f docker-compose.prod.yml exec api node dist/scripts/owner.js complete you@your-domain.example <the code it printed>
   ```
   The code is shown once, works once and expires after 15 minutes. Granting Owner signs that account out everywhere; sign in again. `owner.js status` shows who the Owner is; `owner.js revoke <email> --yes` removes the role. Optional extra staff: `node dist/scripts/admin.js promote <email>` (Admins manage customers/releases/support but get no free subscription and cannot touch credentials).
5. **Company-managed OpenAI and eBay credentials**: sign in as Owner → Console → *API Integrations*. Paste the OpenAI key (and the eBay App ID / Cert ID, environment and RuName) there. They are stored AES-256-GCM encrypted with `CREDENTIALS_ENCRYPTION_KEY`, are never shown again (only a masked hint), and can be replaced, verified, or revoked. *Verify* makes one tiny call to the provider, so **it can cost a fraction of a cent**; nothing is verified automatically. Under *Spending* set the global daily/monthly limit, the per-plan daily limit and the concurrency limit **before** letting customers on; the emergency switch stops all paid calls at once. Nothing calls OpenAI or eBay until credentials are saved.
6. Monitoring: `GET /health` (liveness + database) and `GET /health/ready` (database + Redis; 503 when degraded). `GET /metrics` (bearer `METRICS_TOKEN`) returns request counts and queue depth. The console's *Health* page shows the same plus queue and outbox state.
7. In the desktop app, log in with `Server URL = https://your-domain.example`.

### Email
Without `SMTP_URL` every email (verification, password reset, address change) is only recorded in the `email_outbox` table and **nothing is sent** — fine for staging, not for production. Set `SMTP_URL` (e.g. `smtps://user:pass@smtp.provider.example:465`), `MAIL_FROM` and `SUPPORT_EMAIL`, then test with a real signup. Use a provider that signs mail (SPF/DKIM) for your domain or messages will land in spam.

### Publishing a Windows installer (never automatic)
1. Build it from the desktop project (`npm run dist:beta`) and note its SHA-256.
2. Console → *Releases* → *New release* (version, channel `beta`, notes, known issues) → upload the installer. The **server** computes the SHA-256 and size; check it matches the one you noted.
3. *Approve*, then *Publish* (you type the version to confirm). Only published releases are visible on the public Download page; drafts, approved and withdrawn ones are not. *Withdraw* hides it again. Promoting a beta to the stable channel creates a **draft** stable release you approve and publish separately.
4. The installer is **unsigned** until you buy a code-signing certificate; Windows SmartScreen will warn users (see `BETA_INSTALL_GUIDE.md`). Download counts are one number per release per day — no addresses or browser strings are stored.

## Staging
Run a second copy of the same stack: a separate database, Redis, `.env.staging`, its own subdomain (see the commented block in `Caddyfile.example`), `docker compose -p clynx-staging …` and a different host port. Use Stripe **test** keys and a test OpenAI/eBay sandbox setup there; never point staging at the production database or vault key. Use staging to rehearse every upgrade and the restore procedure below.

## Staged activation (all OFF by default)
- `ENFORCE_ENTITLEMENTS=true` — refuse over-limit watches/devices/AI use by plan (free: 5 watches, 2 devices, 150 AI requests/day; pro: unlimited watches/devices, 3000 AI requests/day). Usage is metered either way. Turn on after you have decided each plan's numbers (`src/entitlements/plans.ts`) and put existing users on the right plan (below). The Owner is never limited by plan; infrastructure safety limits (rate, concurrency, the global budget, the emergency switch) still apply to everyone including the Owner.
- `REQUIRE_VERIFIED_EMAIL_FOR_BILLING=true` — checkout needs a verified email address (turn on once email delivery works).
- `PLAN_PRICE_PRO_MONTHLY_DISPLAY` / `_YEARLY_DISPLAY` — the text on the Pricing page. Until set, the page says the price is not decided yet. The real charge is whatever the Stripe Price says; keep the two in step.
- Billing — see next section. Without Stripe keys everyone stays on their stored base plan.

Set a person's stored base plan (e.g. a comp account): `UPDATE users SET plan = 'pro' WHERE lower(email) = lower('someone@example.com');`

## Billing with Stripe (TEST MODE FIRST — nothing here charges anyone until you use live keys)
1. In the Stripe dashboard (test mode) create a Product "Clynx Pro" with a monthly Price (and optionally a yearly one). Copy the Price ids.
2. Add a webhook endpoint `https://your-domain.example/billing/webhook` subscribed to: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`, `invoice.paid`. Copy its signing secret.
3. Set `STRIPE_SECRET_KEY` (`sk_test_…`), `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO_MONTHLY` (+ `_YEARLY`), then restart the API. The checkout success / cancel / portal-return pages default to the website's own `/account/billing` page; only set the three `BILLING_*_URL` variables to override.
4. Enable the customer portal in Stripe (Settings → Billing → Customer portal) so users can update cards and cancel; allow plan switching between the two Prices if you want upgrade/downgrade there too (the website's own *Switch plan* button uses the API).
5. Test with Stripe's test cards (`4242 4242 4242 4242` succeeds; `4000 0000 0000 0341` fails on renewal) and the Stripe CLI (`stripe listen --forward-to localhost:8787/billing/webhook`, `stripe trigger customer.subscription.updated`).
6. Going live is a separate, deliberate step: swap to live keys/prices/webhook secret. **The billing code has been tested against a simulated provider and Stripe's documented signature scheme; it has NOT been exercised against Stripe's servers** (no credentials were available). Do the test-mode run above before trusting it. `BILLING_FAKE` (the local stand-in used by the previews and the browser tests) is refused when `NODE_ENV=production`.

Behaviour: a trial is offered once per account; `past_due` keeps the paid plan for `PAST_DUE_GRACE_DAYS` (default 7) then drops to free; cancellation at period end keeps the plan until then; webhook events are idempotent (event id is a primary key) and order-safe (an older event never overwrites newer state); a subscription whose period ended long ago with no newer event is not trusted forever. The Owner has no subscription and every billing action is refused for that account.

## eBay
The company's eBay *application* credentials let the server read public listing data for customers (Browse API) through `/ebay/*`; they do **not** give access to any customer's own eBay account. A customer connects their own account separately through eBay's consent page (`EBAY_RUNAME` must be registered with eBay for your domain); their tokens are stored encrypted per customer. eBay's sold-listing data (Marketplace Insights) needs separate approval from eBay and is not used. Start with the SANDBOX environment.

## Backups and recovery
- **Postgres**: daily `docker compose exec -T postgres pg_dump -U $POSTGRES_USER $POSTGRES_DB | gzip > backups/clynx-$(date +%F).sql.gz`, copied off the server; keep 14 daily + 12 monthly. Test a restore (`gunzip -c file | psql`) into a scratch database at least once.
- **Releases volume**: `docker run --rm -v clynx_releases_data:/data -v $PWD/backups:/b alpine tar czf /b/releases-$(date +%F).tgz -C /data .` (volume name is prefixed by your compose project). The database also records each file's SHA-256, so a restored file can be verified.
- **`CREDENTIALS_ENCRYPTION_KEY`**: keep it in a password manager, **separately from the database backups**. The stored OpenAI/eBay credentials are unreadable without it (a restored database with the wrong key just shows them as "needs re-entering" — the Owner pastes them again; nothing else is lost). Rotation: set the new key as `CREDENTIALS_ENCRYPTION_KEY` and the old one as `CREDENTIALS_ENCRYPTION_KEY_PREVIOUS`, restart, re-save each credential in the console, then remove the previous key.
- **Redis** holds only queue state, counters and short-lived spending reservations; losing it loses in-flight jobs (listings are re-processed on the next ingest) and resets rate-limit windows. AOF is on for convenience, not as a backup.
- **Secrets**: keep `.env.prod` in a password manager / secrets store, not only on the server. Rotating `JWT_*` secrets signs everyone out (they log in again).
- **Recovering a lost Owner**: if the Owner account is lost, run `owner.js revoke <old email> --yes` on the server (or nothing, if it no longer exists) and repeat step 4 with a new account. Only someone with shell access to the server can do this.

## Upgrade and rollback
- Take a `pg_dump` first. Upgrade: `git pull && docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build`. Migrations are additive and run on start.
- Rollback: `git checkout <previous tag>` and rebuild. Migrations are forward-only and additive (new tables/columns), so the previous version keeps working against the newer schema; if a migration ever must be reversed, restore the pre-upgrade `pg_dump`.

## Continuous integration
`.github/workflows/ci.yml` runs on every push: desktop typecheck/tests/build (Windows, macOS), cloud typecheck/tests against real Postgres and Redis, the website typecheck/unit tests/build, the website end-to-end run in Chrome against a real server (simulated payments, captured email), a Docker image build (not pushed), and a dependency advisory check. `release.yml` only runs when a maintainer starts it and publishes nothing by itself.

## Security notes
- Website sign-in uses an HttpOnly, SameSite=Lax, `__Host-` prefixed (over https) session cookie holding a random secret that is stored only as a hash; every state-changing request must carry the per-session CSRF token and a same-origin `Origin`. The desktop app keeps using bearer tokens with rotating refresh tokens. All user data access is scoped to the authenticated user id from the session/token (never an id from the request); isolation is covered by tests for every synced resource.
- The page's Content-Security-Policy allows only the site's own scripts, styles, fonts and images; there are no third-party scripts, no advertising or analytics cookies.
- Passwords: Argon2id, length-capped; login is throttled per IP + email (8 failures / 15 min), registration per IP; refresh tokens are hashed, rotated (transactionally), reuse-detected, and revoked on password change. Disabled accounts are refused everywhere.
- Roles are enforced on the server for every request: Owner (full access, no payment, one per installation, granted only by the server-side procedure above), Admin (console without credentials), user. The Owner role cannot be set through any API, registration, or frontend flag; a database trigger refuses changes outside the server procedure.
- The AI proxy only forwards allow-listed models, caps output tokens, rate-limits and limits concurrency per user, reserves estimated spend before each call (global, per-plan and per-user limits), flags and blocks abusive patterns, meters every request with an *estimated* cost (prices are approximations; override with `AI_PRICES_JSON`; the provider's invoice is the truth) and stores no prompt text.
- The company's OpenAI/eBay credentials exist only encrypted in the database (or, as a fallback, in the server environment). Account deletion (`DELETE /me`, or from the website) removes all of a user's rows and cancels their subscription first; the Owner account cannot be deleted through it.
- Run the API as the unprivileged `node` user (the Dockerfile does), keep Postgres/Redis off the public internet, and keep the host patched.

## Facebook Marketplace and platform terms
Clynx reads Marketplace pages through a logged-in browser on the *user's own machine*; Facebook offers no public API for this and its terms restrict automated access. The cloud never scrapes or stores Facebook credentials or sessions. Before offering Clynx commercially, get legal advice on platform terms, keep scan frequency conservative (the app's polling intervals and jitter exist for this), and prefer official APIs where a platform provides one (eBay does). The legal pages on the website (Privacy, Terms, Subscription, Refunds, Cookies) are **drafts** and must be reviewed by a lawyer before launch.
