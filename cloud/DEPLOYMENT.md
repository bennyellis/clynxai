# Clynx Cloud — deployment and operations

Nothing in this repository deploys anything or spends money. These are the steps *you* run, on a server you choose, when you decide to.

## What runs
| Service | What | Notes |
|---|---|---|
| `api` | Fastify HTTP API (`dist/index.js`) | stateless; run 1+ copies behind a TLS reverse proxy |
| `worker` | BullMQ worker (`dist/worker.js`) | processes queued jobs; retries with exponential backoff (5 attempts) |
| `postgres` | PostgreSQL 16 | the only durable state besides Redis AOF |
| `redis` | Redis 7 (AOF on) | job queue + rate-limit counters |

`docker-compose.yml` is the **local dev** stack. `docker-compose.prod.yml` is the production-shaped one (no published DB/Redis ports, secrets from the environment, health checks, memory limits).

## First deployment (a single server with Docker)
1. `cp .env.prod.example .env.prod`, then fill in every blank. Generate secrets with `openssl rand -hex 32` (never reuse the dev defaults).
2. `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build`. Migrations run automatically at API start (idempotent).
3. Put a TLS reverse proxy in front of `127.0.0.1:8787`. Caddy example (`Caddyfile`):
   ```
   api.your-domain.example {
     reverse_proxy 127.0.0.1:8787
   }
   ```
   The API sets `TRUST_PROXY=true` in the prod compose so rate limits use the real client IP. Do **not** expose port 8787 publicly without TLS.
4. Point monitoring at `GET /health` (liveness + database) and `GET /health/ready` (database + Redis; 503 when degraded). `GET /metrics` (bearer `METRICS_TOKEN`) returns request counts and queue depth.
5. In the desktop app, log in with `Server URL = https://api.your-domain.example`.

## Staged activation (all OFF by default)
- `ENFORCE_ENTITLEMENTS=true` — refuse over-limit watches/devices/AI use by plan (free: 5 watches, 2 devices, 150 AI requests/day; pro: unlimited watches/devices, 3000 AI requests/day). Usage is metered either way. Turn on after you have decided each plan's numbers (`src/entitlements/plans.ts`) and put existing users on the right plan (below).
- Billing — see next section. Without Stripe keys everyone stays on their stored base plan.

Set a person's stored base plan (e.g. yourself, a comp account): `UPDATE users SET plan = 'pro' WHERE lower(email) = lower('someone@example.com');`

## Billing with Stripe (TEST MODE FIRST — nothing here charges anyone until you use live keys)
1. In the Stripe dashboard (test mode) create a Product "Clynx Pro" with a monthly Price (and optionally a yearly one). Copy the Price ids.
2. Add a webhook endpoint `https://api.your-domain.example/billing/webhook` subscribed to: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`, `invoice.paid`. Copy its signing secret.
3. Set `STRIPE_SECRET_KEY` (`sk_test_…`), `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO_MONTHLY` (+ `_YEARLY`), and the three `BILLING_*_URL` pages (the checkout success / cancel / portal-return pages you host), then restart the API.
4. Enable the customer portal in Stripe (Settings → Billing → Customer portal) so users can update cards and cancel.
5. Test with Stripe's test cards (`4242 4242 4242 4242` succeeds; `4000 0000 0000 0341` fails on renewal) and the Stripe CLI (`stripe listen --forward-to localhost:8787/billing/webhook`, `stripe trigger customer.subscription.updated`).
6. Going live is a separate, deliberate step: swap to live keys/prices/webhook secret. **This repository's billing code has been tested against a fake provider and Stripe's documented signature scheme; it has NOT been exercised against Stripe's servers** (no credentials were available). Do the test-mode run above before trusting it.

Behaviour: a trial is offered once per account; `past_due` keeps the paid plan for `PAST_DUE_GRACE_DAYS` (default 7) then drops to free; cancellation at period end keeps the plan until then; webhook events are idempotent (event id is a primary key) and order-safe (an older event never overwrites newer state); a subscription whose period ended long ago with no newer event is not trusted forever.

## Backups and recovery
- **Postgres**: daily `docker compose exec -T postgres pg_dump -U $POSTGRES_USER $POSTGRES_DB | gzip > backups/clynx-$(date +%F).sql.gz`, copied off the server; keep 14 daily + 12 monthly. Test a restore (`gunzip -c file | psql`) into a scratch database at least once.
- **Redis** holds only queue state and counters; losing it loses in-flight jobs (listings are re-processed on the next ingest) and resets rate-limit windows. AOF is on for convenience, not as a backup.
- **Secrets**: keep `.env.prod` in a password manager / secrets store, not only on the server. Rotating `JWT_*` secrets signs everyone out (they log in again).

## Upgrade and rollback
- Upgrade: `git pull && docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build`. Migrations are additive and run on start.
- Rollback: `git checkout <previous tag>` and rebuild. Migrations are forward-only and additive (new tables/columns), so the previous version keeps working against the newer schema; if a migration ever must be reversed, restore the pre-upgrade `pg_dump`. Take a dump before every upgrade.

## Security notes
- All user data access is scoped to the authenticated user id from the token (never an id from the request); isolation is covered by tests for every synced resource.
- Passwords: Argon2id, length-capped; login is throttled per IP + email (8 failures / 15 min), registration per IP; refresh tokens are hashed, rotated, reuse-detected, and revoked on password change.
- The AI proxy only forwards allow-listed models, caps output tokens, rate-limits per user, meters every request and stores no prompt text.
- The shared OpenAI key exists only in the server environment. Account deletion (`DELETE /me`) removes all of a user's rows and cancels their subscription first.
- Run the API as the unprivileged `node` user (the Dockerfile does), keep Postgres/Redis off the public internet, and keep the host patched.

## Facebook Marketplace and platform terms
Clynx reads Marketplace pages through a logged-in browser on the *user's own machine*; Facebook offers no public API for this and its terms restrict automated access. The cloud never scrapes or stores Facebook credentials or sessions. Before offering Clynx commercially, get legal advice on platform terms, keep scan frequency conservative (the app's polling intervals and jitter exist for this), and prefer official APIs where a platform provides one (eBay does).
