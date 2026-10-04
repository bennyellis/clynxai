# Clynx Cloud

Standalone backend for Clynx Cloud (Phases 1-4: auth + device registry, Watch
cloud sync, listing ingestion/dedup, and the async job queue). This is a
separate project from the Electron app — its own `package.json`/
`tsconfig.json`, never bundled into the desktop build.

The API (`src/index.ts`) and the job worker (`src/worker.ts`) are two
separate processes, both talking to the same Postgres + Redis. Run both when
developing locally.

## Setup — local development (hot reload)

```bash
cd cloud
npm install
cp .env.example .env       # fill in real secrets (JWT_ACCESS_SECRET / JWT_REFRESH_SECRET — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
npm run db:up               # starts Postgres (5432) + Redis (6379) via docker compose
npm run migrate              # applies cloud/src/db/migrations/*.sql
npm run dev:all               # starts Postgres/Redis, runs migrations, and starts the API + worker together
```

Or run each piece by hand: `npm run dev` (API) and `npm run dev:worker`
(worker) in separate terminals. Use this mode while actively changing cloud
code — `tsx watch` restarts on every save.

## Setup — persistent/production-like (containerized, survives reboots)

`docker-compose.yml` also defines `api` and `worker` services (built from the
repo's own `Dockerfile`, alongside Postgres/Redis), so a single command runs
the whole stack with no host Node process to keep alive:

```bash
cd cloud
cp .env.example .env       # same as above — secrets only, never committed
docker compose up -d --build
```

This builds a compiled (`npm run build`) production image for the API and
worker, runs migrations automatically on every `api` container start (safe —
`schema_migrations` makes it idempotent), and sets `restart: unless-stopped`
on every service — they come back up automatically after Docker restarts,
and (if Docker Desktop itself is set to start on login) after a machine
reboot too. The API is still published on `localhost:8787`, so the desktop
app's `config.json` (`cloud.apiUrl`) doesn't need to change.

After changing cloud code, rebuild with `docker compose up -d --build` again
— there's no hot reload in this mode, unlike `npm run dev:all`.

Use whichever mode fits: hot-reload while iterating on `cloud/` itself,
containerized when you just want cloud sync running in the background for
the desktop app without babysitting a terminal.

## Testing

Tests run against a real Postgres database and a real Redis instance (Redis
state is ephemeral/shared — no per-suite isolation needed there, unlike
Postgres). Create a `.env.test` (same shape as `.env`, pointed at a
disposable database) before running:

```bash
npm test
```

`test/setup.ts` runs migrations against that database automatically before
the suite.

## Scripts

- `npm run dev` — start the Fastify API with hot reload
- `npm run dev:worker` — start the job worker with hot reload
- `npm run dev:all` — start Postgres/Redis, migrate, then run API + worker together (uses `concurrently`)
- `npm run db:up` / `npm run db:down` — start/stop the local Postgres + Redis containers (no `-v`, volumes persist)
- `docker compose up -d --build` / `docker compose down` — start/stop the FULL containerized stack (Postgres + Redis + API + worker), for persistent/production-like use
- `npm run build` — compile TypeScript to `dist/`
- `npm start` / `npm run worker` — run the compiled API / worker
- `npm run typecheck` — `tsc --noEmit`
- `npm test` — run vitest against real Postgres + Redis
- `npm run migrate` — apply any pending SQL migrations

## Endpoints

**Health**
- `GET /health` — DB connectivity check, no auth

**Auth**
- `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`

**Devices** (require `Authorization: Bearer <accessToken>`, scoped to the caller's own devices)
- `POST /devices/register`, `POST /devices/:id/heartbeat`, `GET /devices`

**Watches** (require auth, scoped to the caller's own watches, last-write-wins by `updatedAt`)
- `GET /watches?since=`, `PUT /watches/:localId`, `DELETE /watches/:id`
- `POST /watches/:id/matches`, `GET /watches/:id/matches?since=`

**Listings** (require auth; shared canonical cache, not per-user — see the
architecture note on Database vs. product intelligence cache)
- `POST /listings/ingest` — single listing or `{ listings: [...] }` batch; dedupes by `(source, source_listing_id)`; enqueues a processing job on first ingest only
- `GET /listings/:id/jobs` — job status/history for a listing

## Job queue

New listings automatically enqueue a `listing-processing` job (BullMQ +
Redis) on first ingest. The worker's processor is currently a **stub** — it
does not call any AI service, just marks the job `completed` with a
placeholder result. Job rows live in Postgres (`listing_processing_jobs`) so
status is queryable without talking to Redis directly. Wiring a real AI
processor (e.g. porting product identification from the desktop app's
`openai.ts`) is a deliberate future step, not yet done.
