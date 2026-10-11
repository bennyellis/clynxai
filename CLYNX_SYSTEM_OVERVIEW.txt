# Clynx: complete system overview (for an external AI reviewer)

Prepared from a direct read of the codebase (not from marketing copy). Facts here were checked against the code as of 2026-10-11 (app version 0.2.0). Where something is a judgment rather than a fact, it says so. No secrets are included; environment variable *names* are listed, never values.

---

## 0. How to use this document (instructions for the reviewing AI)

The owner is preparing to **launch Clynx as a paid SaaS product very soon**. Please act as a senior reviewer (product, architecture, security, legal/compliance, ops, and cost) and produce:

1. **A prioritized list of what to REMOVE, CHANGE, and ADD** before launch. For each item: what, why, evidence (file or section of this document), severity (Blocker / High / Medium / Low), and rough effort (hours/days/weeks).
2. **The top 10 launch blockers**, in order.
3. **A recommended launch architecture** if you think the current one is wrong for SaaS (see section 12: the product is currently a *desktop* app that scrapes Facebook from each user's own machine, plus a thin cloud backend).
4. **Unit economics sanity check**: AI/infra cost per active user vs. a plausible price (section 11 has the cost drivers).
5. **Questions you need answered** that this document does not answer.

Be skeptical and concrete. Section 11 ("Known risks and gaps, candidly") is the author's own list; treat it as a starting point, not as complete, and challenge it.

The document is long on purpose. Sections 1-3 are the quick orientation; sections 4-9 are the detailed mechanics; sections 10-13 are the review material.

---

## 1. What Clynx is

**Clynx** is a Windows desktop app (Electron + React + TypeScript) for **resellers**. It automates finding underpriced items on **Facebook Marketplace** (and, secondarily, **eBay**) that can be flipped for profit on eBay, and pushes **phone notifications** (via ntfy) when it finds a good one.

Core user promise: *"Tell Clynx what you want, or let Clynx discover opportunities you didn't know existed."*

Main capabilities:

- **Scanner**: drives the user's own Chrome (Playwright, stealth-patched) on one or more of the user's Facebook accounts, browsing Marketplace by location and searching for the user's "Search For" items. Each listing is opened, read, scored, and (if good) alerted.
- **Money model**: converts a listing's asking price into expected profit after eBay fees, using real sold-price data (WatchCount) and live asking prices (eBay Browse API), with a configurable minimum margin and a cap on how much negotiating a deal may require.
- **Product Database ("Library")**: Clynx researches products (web research, eBay comps, reference photos) and builds a knowledge base used to price listings and recognize items in photos.
- **Discovery tab**: live feed of products Clynx is researching, with its verdict on whether each is worth flipping.
- **Watches**: persistent monitors (Facebook or eBay) that run even when the main scanner is stopped and notify on their own topic.
- **Clynx, the AI assistant**: a chat persona (several entry points) that can answer reselling questions, research products, and *operate the app* through tool calls (start/stop scanner, edit settings, manage Search For items, create Watches...).
- **Cloud backend** (separate project, `cloud/`): auth, device registry, sync of Watches / feedback / Database products, shared listing cache, a job queue (stub), a cross-user search-demand aggregator (manual), entitlements (defined, not enforced), and an **OpenAI reverse proxy with one shared key**.

Distribution state: a Windows build via electron-builder exists as a script (`npm run dist`); **no code signing, no auto-update, no installer polish, Windows only**. The app currently defaults its cloud URL to `http://localhost:8787` (local Docker stack).

---

## 2. Architecture at a glance

```
                          ┌───────────────────────────── user's PC ─────────────────────────────┐
                          │                                                                      │
  Facebook Marketplace ◄──┼─ Playwright (real Chrome, stealth plugin, persistent profile per FB   │
  (scraped, logged-in)    │   account)  ── scrapeEngine.ts / scraper.ts                           │
                          │                                                                      │
  WatchCount.com ◄────────┼─ same Chrome context, new tab; user logs in by hand (sold-price comps)│
  eBay Browse API ◄───────┼─ ebayClient.ts / ebayActive.ts / ebayEngine.ts (client-credentials)   │
  DuckDuckGo HTML,        │                                                                      │
  Wikipedia, Wikidata,    │  Electron MAIN process (index.ts ~4.2k lines): orchestrates engines, │
  OSM Nominatim ◄─────────┼─ IPC (≈86 channels), SQLite store (node:sqlite), config.json,         │
                          │  notifications, sync services                                         │
  ntfy.sh ◄───────────────┼─ HTTP POST (topic in URL path, optional photo upload)                 │
                          │                                                                      │
                          │  Electron RENDERER (React 18): Dashboard, Activity, Feed, Watch,      │
                          │  Database(Discovery/Library/Blacklist), Config, Login                 │
                          └───────────────┬──────────────────────────────────────────────────────┘
                                          │ HTTPS/HTTP (JWT access 15 min, refresh 30 days)
                                          ▼
                        ┌──────────── Clynx Cloud (Fastify + Postgres + Redis/BullMQ) ────────────┐
                        │ /auth  /devices  /watches  /listings/ingest  /feedback  /products       │
                        │ /search-planner  /me/entitlements  /ai/chat/completions  /ai/images/...  │
                        │ worker process (BullMQ listing job: STUB)                                │
                        └───────────────────────────────┬──────────────────────────────────────────┘
                                                        ▼
                                              OpenAI API (one shared key, gpt-5-mini, gpt-image-1)
```

Key architectural facts:

- **The scanning happens on the user's machine**, using the user's own Facebook login in a local Chrome profile. The cloud does not scrape anything.
- **Local SQLite is the source of truth** for listings, products, watches, feedback. The cloud is a background *mirror* (last-write-wins sync), not the primary store.
- **AI calls** go straight to OpenAI if a local `OPENAI_API_KEY` exists, otherwise through the cloud proxy using the user's session. All AI uses model `gpt-5-mini` (reasoning model, always called with `reasoning_effort: "minimal"`), plus `gpt-image-1` for category thumbnails.
- **Per-user isolation on a machine**: after login, all paths are re-pointed to `data/users/<userId>/` (config.json, scout.db, browser-profiles/), so multiple cloud users on one PC don't share data.
- **A "Save OpenAI credits" mode (`lowAiMode`, default ON)** restricts AI to essential jobs and uses free/heuristic paths elsewhere. This was added deliberately to control cost.

---

## 3. Tech stack and repository layout

**Desktop**: Electron 44.2.0, electron-vite 2.3 / Vite 5, React 18.3, TypeScript 5.7, `node:sqlite` (Node's built-in, still an *experimental* module in Node 24), Playwright 1.49 + playwright-extra + puppeteer-extra-plugin-stealth, sharp 0.35 (image resizing), dotenv. electron-builder 25 for packaging (Windows only).

**Cloud**: Node 20 (Docker alpine), Fastify 5, Postgres 16, Redis 7, BullMQ 5, argon2 (password hashing), jose (JWT HS256), zod (validation), vitest. Docker Compose with four services (postgres, redis, api, worker).

**Size** (lines of code): desktop main process ≈ 25.6k (56 files), renderer ≈ 16.4k (incl. 1.6k CSS), cloud ≈ 2.1k + 362 SQL + 1.8k tests.

Repo layout:

```
src/main/        Electron main process: engines, store, AI, sync, notifications
src/preload/     contextIsolation bridge (window.api, ~411 lines)
src/renderer/    React UI (screens/, components/, lib/, styles/global.css)
cloud/           Separate Fastify backend project (own package.json, Dockerfile, compose, tests)
build/, resources/  icons and static assets
README.md        STALE (still describes Groq/Gemini keys; see section 11)
.env.example     STALE (Groq/Gemini variables)
```

Largest files (God-file candidates): `index.ts` 4,218 lines; `scrapeEngine.ts` 3,597; `store.ts` 2,864; `Database.tsx` 3,130; `scraper.ts` 1,335; `chat.ts` 1,297; `vision.ts` 1,278; `types.ts` 1,236; `cloudClient.ts` 1,090; `webResearch.ts` 1,021; `scorer.ts` 828.

---

## 4. Runtime, data, and persistence

### 4.1 Startup and login

1. The app loads install-level files from its base dir (`app.getPath("userData")` when packaged; the project folder in dev): `app-settings.json` (cloud API URL, default `http://localhost:8787`), `cloud-session.json` (refresh token + device id + user id + email + apiUrl, **plaintext**), `.env` (API keys, **plaintext**).
2. The renderer shows **LoginScreen** (Server URL + email + password, login/register toggle) and blocks the whole app until `auth:getSession` reports authenticated. A relaunch silently restores the session from the stored refresh token.
3. On successful auth, `bootstrapUserSession(userId, email)` runs: re-points `CONFIG_PATH`, `DB_PATH`, `PROFILES_ROOT` to `data/users/<userId>/`, loads/migrates config, opens the SQLite store, constructs one `ScrapeEngine` per Facebook account, the `EbayEngine`, the `WatchScheduler`, and four sync services (watches, feedback, products, listing ingest). It also does a one-time copy of legacy single-user data into the first user's folder.
4. Logout stops all engines and sync services.

### 4.2 Files on disk (per machine)

| File / dir | Contents | Sensitive? |
|---|---|---|
| `.env` | `OPENAI_API_KEY`, `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, legacy `CLYNX_CLOUD_EMAIL/PASSWORD` | Yes, plaintext |
| `cloud-session.json` | refresh token, device id, user id, email, api url | Yes, plaintext |
| `app-settings.json` | cloud API URL | No |
| `data/users/<id>/config.json` | all user settings (≈36 KB in a mature install), Search For list, accounts, ntfy topic, theme, etc. | Personal |
| `data/users/<id>/scout.db` | SQLite: listings, products, images, watches... | Personal; **one real user DB is 544 MB** (images stored as base64 data URIs inside SQLite); the dev `data/` folder is 3.3 GB across users |
| `data/users/<id>/browser-profiles/<accountId>/` | A full Chrome profile per Facebook account: **logged-in Facebook (and WatchCount) cookies/session** | Very sensitive, unencrypted |

### 4.3 SQLite schema (local, `store.ts`)

Tables: `listings` (every scanned listing, with scoring fields, seller fields, photo analysis, flaws), `feedback` (Feed good/bad), `flaw_feedback`, `products` (the Database: name, aiSummary, observedNotes, category, family path, logo/thumbnail, user's resale history, desired price, eBay comps: avg sold, run time, shipping, sample size, active median, estimated value + basis, my-store reference, parent product id for model variants), `category_dismissals`, `product_images` (reference photos, kind normal/poor_condition), `blacklist_terms`, `blacklisted_images`, `group_thumbnails`, `watches`, `watch_matches`, `pending_cloud_deletes`, `watch_seen_listings`, `watch_searches`, `geocode_cache`, `schema_flags`.

Migration approach: additive `ALTER TABLE ... ADD COLUMN` in code on startup, plus one-time data migrations gated by rows in `schema_flags` (examples: `comps-conflict-2026-10-07`, `comps-shipping-2026-10-07`, `state-top-cities-2026-10-07`). There is no migration framework or versioned schema, and no down-migrations.

### 4.4 In-memory only state

Activity log lines, pipeline metrics (`metrics.ts`), the Discovery feed (40 entries x 40 thoughts), the bundle-breakdown cache, and engine status maps live only in memory and are lost on restart.

---

## 5. Core pipelines (how it actually works)

### 5.1 The scanner (`scrapeEngine.ts`, `scraper.ts`, `browser.ts`)

- One `ScrapeEngine` instance per enabled Facebook **account**. Each owns a persistent Chrome context (real Chrome via Playwright `channel: "chrome"`, fallback to bundled Chromium with a spoofed UA), patched by the stealth plugin. Pace is made deliberately slow and randomized (`politeDelay`).
- **Locations**: per account, a mode of *nationwide* (rotates big cities), *state* (that state's top 10 cities, from a hardcoded table in `stateCities.ts`), or *city/ZIP* (stays put). Location discovery may use an AI call as a fallback.
- **A pass** = for each location: a *general browse* of recent listings plus a dedicated search for each Search For item. Between passes the engine sleeps (default 2-5 min, configurable, "Skip wait" button).
- **Listing evaluation order** (`evaluateListing`), simplified:
  1. Dedupe (already seen), blacklist title match, placeholder/suspicious price skip (`placeholderPrice.ts`: ≤ $1, or 4+ digit repeats/sequences like 1111 or 1234), age limit, unshippable categories, non-round price quirks.
  2. Fetch the detail page (description, photos, seller info, shipping).
  3. **Seller risk** screen (`sellerRisk.ts`: account age, profile photo, rating thresholds; defaults: enabled, min age 1 year, profile photo required).
  4. **Scoring** (`scorer.ts`), three pathways: *Search* (matches a Search For item by keywords; deterministic arithmetic against the product's eBay value), *Database title path* (recognizes a product already in the Database from the title), and *General* (an AI call judging an unmatched listing, "unverified pricing" tier).
  5. Save to SQLite, push to the renderer.
  6. **Vision** (`vision.ts`) runs as a bounded background queue: analyzes listing photos for what is really shown, mismatch against the title, condition flaws, bundled extras, thumbnails.
  7. Mismatch override, **bundle valuation** (5.6), hidden-gem logic, Database research of newly seen products, Watch matching.
  8. If a deal: **pre-alert market check** (`preAlert.ts`), then ntfy.
- **Skip reasons are logged** and shown in the Activity screen (with a "hide routine skips" toggle).

### 5.2 The money model (`resaleMath.ts`, `profitGate.ts`, `scorer.ts`, `marketValue.ts`)

- **Value of a product** = what a buyer pays *in total* on eBay (sold item price **plus** shipping the buyer paid). The user keeps **84%** of that (configurable `ebayNetPercent`; the Database UI shows a range of 80-86%).
- **Profit** = keep − (asking price + shipping). **Margin** = profit / keep. A deal needs margin ≥ **20%** (`minProfitMarginPercent`).
- **Negotiation cap**: if reaching the margin would require negotiating more than **15%** below asking (`maxNegotiationPercent`), the listing is skipped ("Skip deals that need more than ___% off").
- **Estimated value** (`estimateMarketValue`): blends WatchCount sold average with eBay active-listing median; if one sale conflicts with many asks it returns no estimate rather than a bad one; with few sold comps asks pull the estimate toward the market.
- **Condition**: minor flaws scale value to 0.6, major to 0.25 (`CONDITION_VALUE_MULTIPLIER`), except broken/for-parts listings of a Search For item with "Include broken" on, which are priced from a separate Database *variant* "(For Parts / Broken)" valued from eBay's "for parts or not working" data.
- **Placeholder prices** ($0, $1, $1234...) are skipped everywhere (scanner, Watch prefilter, eBay engine, final alert gate).
- **Descriptions are read literally**: extras the seller prices separately ("also have a 1TB card for $120", parted-out price lists) are *not* counted as included.

### 5.3 Product intelligence (the "Database")

- `runProductLookup` (in `index.ts`) researches a product: `lookupProduct` (AI + live web research from DuckDuckGo HTML / Wikipedia, producing summary, category, family path, a short "reaction" line), a brand/family logo (Wikidata first), a stock photo gallery (verified by a vision check), then **eBay comps**.
- **eBay comps** (`fetchAndStoreEbayComps`): derive a WatchCount query, scrape WatchCount sold listings in a browser tab (needs the user to be logged into WatchCount: anonymous cap ≈ 20 lookups/day vs ≈ 200 logged in), have AI/heuristics discard non-matching comps (`compFilter.ts`, `ebayProductFilter.ts`, `compPhotoCheck.ts`), compute averages, fetch eBay Browse API active asks (`ebayActive.ts`), and store value + basis (`sold` / `blend` / `active`).
- **Product identity** (`productIdentity.ts`): a specific model/color becomes a *child entry* of a generic entry instead of a duplicate.
- **Families and categories**: AI-assigned multi-level family path ("Xbox > Games > Xbox 360"), brand logos, folder thumbnails, category thumbnails generated with `gpt-image-1`.
- **Auto-discovery of siblings/variants** (first research only): other games for a console generation (cap 6) and named variants (cap 5), each a full research pass.
- **Reference photos** feed vision: the scanner compares listing photos to the Database's photos of the same product.

### 5.4 Discovery tab and product verdicts (new)

Left: live feed of products Clynx is researching (`discovery.ts`, in-memory, pushed over IPC). Right: one window with a card per product: Clynx's research thoughts plus a **deterministic verdict** (`productVerdict.ts`: worth, what you'd keep, the maximum purchase price that still earns the user's margin, profit per flip, sell speed, evidence strength, asking-vs-sold sanity). Includes an "ask Clynx" box with photo and text-file attachments. By explicit product rule, Discovery/Database is about **products only**, not listings or sellers.

### 5.5 Watches (`watchScheduler.ts`, `watchFacebook.ts`, `watchMatching.ts`, `ebayEngine.ts`)

A Watch is a persistent condition (terms, price range, location mode/radius, platform facebook|ebay, own ntfy topic, check interval with jitter). The scheduler runs due Watches independently of the main scanner, prefilters results cheaply (seen before? price? title match? blacklist? geo-radius via Nominatim geocoding cache), then evaluates survivors through the same pipeline. Watch matches are **always delivered** (`canWithhold: false`) but still rated.

### 5.6 Bundles (`bundleBreakdown.ts`, new)

For a listing holding several products ("PS5 Pro with 2 controllers and a 2TB drive"): one small text-only AI call splits it into items (main/accessory/extra, quantity, sellability, rough guess); each extra is priced on its own (Database value if recent, else a real WatchCount+eBay lookup filed as a Database product); the **lot is valued non-linearly**: the main item is the focal point, extras add `weight x price` (accessory 0.55, extra 0.45, additional units x0.5) with a soft cap near 30% of the focal item's value, slow/bulky items (monitors, TVs, run time ≥ 14 days) are left out. Example: console alone $1100, two $40 controllers, a $90 drive → lot ≈ $1166, not $1270. Runs only for deals, near-miss "hidden gems", and Watch candidates. The photo-based lump estimate remains as a fallback for extras visible only in photos.

### 5.7 Alerts (`dealSummary.ts`, `preAlert.ts`, `notify.ts`)

- Before a deal alert goes out, `prepareAlert` runs a **market check** (WatchCount + eBay, unless the exact product was checked < 3 days ago), refreshes the Database, rates the deal 1-5 whole stars, and *withholds* alerts that would need too deep a cut.
- ntfy message: title `🟦|🟩 $price - product - Listed N ago` (blue = Facebook, green = eBay), body `reason - ⭐⭐⭐`. The topic is part of the URL path (`https://ntfy.sh/<topic>`); a listing photo may be uploaded as the request body. Header values are RFC 2047 encoded.
- Placeholder-priced listings never alert (even Watch matches).

### 5.8 The assistant ("Clynx") (`chat.ts`, `clynxPersona.ts`, `GlobalAssistantBar.tsx`)

One persona ("a flipping partner and expert on Facebook Marketplace and eBay"), several windows: Activity chat (full admin), a floating bubble on other screens (admin + research), Discovery/Database chat (research, blacklist), and a per-product chat. **Tools** (OpenAI function calling, up to 4 rounds): `add_search_item`, `remove_search_item`, `add_custom_instruction`, `set_general_deal_detection`, `update_config`, `start_scanner`, `stop_scanner`, `clear_feed`, `create_watch`, `pause_watch`, `resume_watch`, `delete_watch`, `list_watch_matches`, `research_product`, `web_research`, `add_product_watch_note`, `add_blacklist_term`, `remove_blacklist_term`. Tool access is enforced twice (tool list sent to the model, and again server-side in `executeChatTool`). The OpenAI key itself is not reachable by any tool. `web_research` fetches and skims real web pages and hands their text to the model.

### 5.9 eBay as a source (`ebayEngine.ts`, `ebayClient.ts`)

Application-level OAuth (client credentials) against the eBay Browse API, searching active listings for Search For items and Watches; skips raw placeholder prices before spending an API call. Credentials come from `.env` (`EBAY_CLIENT_ID/SECRET`). Marketplace Insights (sold data) is **not** available (403), which is why sold data comes from scraping WatchCount.

---

## 6. UI map (renderer)

- **Sidebar** + `App.tsx` (screen switching keeps all screens mounted; global state for engine status, research activity, Database icon glow).
- **Dashboard**: Start/Stop scanner, per-account Live panels (current listing, "Sleeping for X min" countdown with Skip wait), Search For list (add product, price range, "Include broken", Recent searches), Best Deals.
- **Activity**: live log + assistant chat, metrics panel.
- **Feed**: grid of evaluated listings (deals / worth-a-look) with cards (photos, price, reason, Interested / Not interested / Research), size slider.
- **Watch**: Watch list, creation flow (`WatchFormFlow`), Matches modal.
- **Database**: tabs **Discovery**, **Library** (product tiles, folders, product detail pages with eBay value panel, reference photos, resale history, "Your eBay store" panel), **Blacklist** (terms + auto-blacklisted images).
- **Config**: Sources (accounts, locations, wait), Deals (thresholds, margin, negotiation, Save-credits mode, WatchCount, eBay store), Appearance (theme, colors, particles, sounds), Notifications (ntfy), Account (cloud status).
- **LoginScreen**: mandatory.
- Heavy visual layer: starfield canvas background, custom cursor, click particles, sound effects, performance rules (animations limited to transform/opacity because of an Intel iGPU @144Hz).

---

## 7. IPC surface

About 86 `ipcMain.handle/on` registrations, grouped: `config:*`, `env:*` (save OpenAI key, check eBay credentials), `engine:*` (status map, start, stop, skipWait, runOnce, login, checkLogin, openWatchCountLogin), `accounts:*`, `listings:*` (list, count, feedback, notInterested, research, delete, clearAll, flawFeedback), `products:*` (list, refresh, edit, images, thumbnails, backfill, refreshEbayComps, searchNow, createManual...), `watch:*`, `blacklist:*`, `blacklistImages:*`, `auth:*`, `cloud:getStatus`, `ebayStore:link`, `metrics:*`, `research:status`, `discovery:list`, `ai:chatStart` (streaming via `ai:chatChunk/Done/Error`), `searches:removeRecent`, `filters:*`, `location:setMode`, `images:*`. Push events include `engine:log`, `engine:listing`, `engine:statusMap`, `products:updated`, `research:status`, `discovery:entry`, `watches:updated`.

A safety check used during development: every `ipcRenderer.invoke/send` channel name in `preload/index.ts` must have a handler string in `index.ts`.

---

## 8. Cloud backend (`cloud/`)

### 8.1 Services

Two processes (API + worker) over Postgres + Redis, via Docker Compose (`restart: unless-stopped`, migrations on API start).

### 8.2 Endpoints (all but `/health` and `/auth/*` require `Authorization: Bearer <jwt>`)

- `GET /health` (DB check)
- `POST /auth/register | login | refresh | logout`
- Devices: `POST /devices/register`, `POST /devices/:id/heartbeat`, `GET /devices`
- Watches: `GET /watches?since=`, `PUT /watches/:localId`, `DELETE /watches/:id`, `POST|GET /watches/:id/matches`
- Listings: `POST /listings/ingest` (single or batch, dedupe on `(source, source_listing_id)`, enqueues a job on first insert), `GET /listings/:id/jobs`
- Feedback and Products sync (revision-based pull cursors)
- Search Planner (manual trigger): aggregates **all users' enabled Watch phrases** into demand snapshots
- `GET /me/entitlements`
- **`POST /ai/chat/completions`, `POST /ai/images/generations`**: reverse proxy to OpenAI with the single shared key; supports streaming pass-through.

### 8.3 Schema (Postgres, 9 migrations)

`users` (email, argon2 password hash, `plan` default 'free'), `devices`, `refresh_tokens` (SHA-256 hashed, rotated, reuse-detection), `watches`, `watch_matches`, `listings` (shared canonical cache: source, source_listing_id, title, description, price, url, images, location text, seller name/join year/rating, first/last seen), `listing_processing_jobs`, `listing_feedback`, `user_products`, `search_demand_snapshots`; `revision BIGSERIAL` columns on synced tables for pull cursors.

### 8.4 Auth design

Argon2 password hashing; access JWT HS256, 15 min; refresh token = 32 random bytes, stored hashed, 30-day expiry, rotated on use, **atomic revoke-and-reissue**, and presenting an already-revoked token revokes *all* of that user's tokens (theft/reuse signal). Login returns a generic error for unknown email or bad password.

### 8.5 Sync model (desktop side, all feature-flagged background mirrors)

`watchSync`, `feedbackSync`, `productSync`, `listingIngestSync` run every ~60 s after a startup delay. Last-write-wins; pull uses server revision cursors; failures freeze the push cursor so nothing is skipped; local deletes are queued in `pending_cloud_deletes`. **`listingIngestSync` pushes every scanned listing (not only deals), including seller names/ratings, to the shared `listings` table**, to preserve "General Discovery" potential. Product sync covers core fields only; **images are not synced** (no object storage).

### 8.6 Tests

`cloud/test/*.test.ts` (vitest, real Postgres + Redis): auth, devices, watches, listings, queue, feedback, products, searchPlanner, entitlements. Desktop has **one** unit test file (`listingSource.test.ts`). `npm audit` (prod deps): **cloud: 0 vulnerabilities; desktop: 2 high** (`sharp < 0.35.5` via librsvg CVE, and `glob > brace-expansion` DoS), both with `npm audit fix` available.

---

## 9. External dependencies and their terms/limits

| Dependency | How it's used | Concern |
|---|---|---|
| **Facebook Marketplace** | Browser automation of the user's own account | Violates Facebook ToS (automated collection); account restriction/ban risk; DOM changes break scraping; the README already warns users |
| **WatchCount.com** | Browser-scraped sold-comps (needs the user's WatchCount login for higher cap) | Third-party scraping, no API; cap 20/day anon vs 200/day logged in; availability and ToS |
| **eBay Browse/Taxonomy API** | Active listings, categories, seller items | Needs eBay developer keys (currently per-install in `.env`); API license/rate limits; Marketplace Insights not available |
| **OpenAI** | `gpt-5-mini` (chat, scoring, vision, research, comps filtering, bundle breakdown), `gpt-image-1` | Single point of cost and failure; shared key for all users via proxy |
| **DuckDuckGo HTML, Wikipedia, Wikidata** | Web research, product/brand images | Scraping a search engine's HTML; fragile; bot blocking |
| **OSM Nominatim** | Geocoding Watch locations | Public service, 1 req/s policy, results cached |
| **ntfy.sh** | Phone notifications | Public server, topic name is the only "secret"; anyone who knows or guesses the topic can read the alerts and post to it |
| **Chrome (installed)** | Required by Playwright `channel: "chrome"` | Falls back to bundled Chromium only if available (`postinstall: playwright install chromium` is a dev-install step, not part of a packaged app) |

Geography/currency: **US-only** assumptions throughout (USD, US states and cities table, Facebook US locations).

---

## 10. Configuration surface (user-facing settings in `Config`)

`accounts[]` (per-account label, enabled, Facebook browse URLs, location mode, selected state / city / ZIP, radius, headless override), `listingsPerLocation` (20), `headless`, `pollIntervalMinutesMin/Max` (2-5), `dealThresholdPercent` (35), `ebayNetPercent` (84), `minProfitMarginPercent` (20), `maxNegotiationPercent` (15), `lowAiMode` (true), `searchItems[]` (item, keywords, min/max price, reference resale price, includeBroken, linked Database product), `generalDeal` (AI general-deal mode on/off, min confidence), `customInstructions`, `ntfy {server, topic}`, `sellerRisk` (enabled, min account age 1y, min rating, rating-count bounds, require profile photo), `photoAnalysis.enabled` (true), `maxListingAgeHours` (24), appearance (theme, colors, rainbow, transparency, particles, sound, desktop notifications), `watchCountEnabled` (true), `watchCountOncePerScan`, `ignoreBlacklist`, `autoResearchListings` (true), `researchCondition` (flaw detection, default off), `rotateSearchItems(+Count)`, `watch {globallyPaused, matchesLastViewedAt}`, `cloud`, `ebay.enabled`, `facebookEnabled`, `ebayStoreUsername`, `recentSearches`.

---

## 11. Known risks and gaps, candidly (the author's own list; challenge it)

Severity here is the author's first guess for a **public paid launch**.

### 11.1 Business / legal / platform

1. **Blocker: the product's core mechanism violates Facebook's Terms of Service** and runs on each customer's own logged-in account. Account bans are a real possibility, and the vendor would be selling a tool whose main feature breaks a third party's ToS. This needs a legal opinion and a strategy decision (see section 12), not just code.
2. **High: WatchCount scraping** (and DuckDuckGo HTML scraping) has no API or license; sold-price data is central to the whole money model.
3. **High: no billing, plans, or paywall.** `users.plan` exists (default `free`); `getEntitlementsForPlan()` defines `free` (5 watches, 2 devices, 10 search items, **AI research disabled**) and `pro` (unlimited); **nothing enforces any of it**. There is no Stripe/Paddle, trial, invoicing, tax, refunds, or dunning.
4. **High: privacy and compliance.** No Terms of Service, Privacy Policy, DPA, cookie/consent text, data-retention policy, or account/data deletion flow. The shared `listings` table receives *every* scanned listing from *every* user including **third-party sellers' names, ratings, locations and listing text**, with no per-user attribution and no retention limit: this is personal data of people who never agreed to anything (GDPR/CCPA exposure). The Search Planner aggregates all users' Watch phrases. There is no user export/delete endpoint.
5. **Medium: US-only** assumptions (currency, cities, locales), no i18n.

### 11.2 Security

6. **Blocker: the shared-key AI proxy is unmetered and open to any registered user.** `POST /ai/chat/completions` forwards the client's body **verbatim** (any model, any `max_tokens`, any tools, vision inputs) to OpenAI with the vendor's key; there is **no per-user quota, rate limit, model allow-list, token cap, or spend alarm**, and registration is open with no email verification. One abusive user (or leaked/stolen token, or a modified client) can burn the whole OpenAI budget. `/ai/images/generations` likewise.
7. **High: no rate limiting or abuse controls anywhere** in the API (auth endpoints included: credential stuffing, mass registration, and bcrypt/argon2 CPU DoS are all open). No CORS/helmet/headers hardening, no request logging policy (Fastify logger is on).
8. **High: no email verification, password reset, MFA, or account lockout.**
9. **High: plaintext secrets and sessions on the client**: `.env` (OpenAI key if used locally, eBay secret), `cloud-session.json` (refresh token), and unencrypted Chrome profiles containing **live Facebook sessions** (cookies). Electron `safeStorage` / OS keychain is not used. Legacy `CLYNX_CLOUD_EMAIL/PASSWORD` plaintext variables are still present in the author's `.env` (the login UI superseded that mechanism).
10. **High: indirect prompt injection.** `web_research` returns raw text of arbitrary web pages to the model *in the same chat contexts that hold admin tools* (`update_config`, `start_scanner`, `clear_feed`, `delete_watch`, ...). A malicious page could try to make the assistant change settings or delete data. Similar exposure: listing descriptions and photos are fed to AI scoring/vision (lower impact: no tools there, but they can manipulate scoring).
11. **Medium: ntfy topics are unauthenticated and public** on ntfy.sh; the topic name is the only secret and defaults to user-chosen text. Alerts include listing titles and photos.
12. **Medium: infrastructure defaults** in `cloud/docker-compose.yml`: Postgres password is the literal `clynx_dev_password`, Postgres (5432) and Redis (6379, **no auth**) are published on host ports, the container runs as root, there is no TLS termination, and the desktop default API URL is `http://localhost:8787`. JWT secrets are symmetric HS256 shared by api and worker. Refresh tokens last 30 days with no per-device revocation UI.
13. **Medium: Electron hardening gaps**: `contextIsolation: true` and `nodeIntegration: false` are set (`sandbox` is not set explicitly; it relies on Electron's default, which should be on for a renderer with a preload, but the reviewer should confirm for Electron 44), the CSP allows `style-src 'unsafe-inline'` and `img-src https: data:` (any https image), and `setWindowOpenHandler` calls `shell.openExternal(url)` for **any** URL without scheme validation (should allow only http/https). IPC handlers take renderer-supplied args with little validation.
14. **Medium: dependency vulnerabilities** (desktop: `sharp`, `brace-expansion` via `glob`, 2 high; fixable). No dependency/SAST scanning in CI because there is **no CI**.
15. **Low/Medium: the cloud trusts client-reported data** (listing ingest content, product profiles, feedback) with schema validation but no abuse/size/rate controls beyond a 10 MB body limit.

### 11.3 Architecture / scale

16. **High: SaaS vs desktop mismatch.** Everything that matters (scraping, scoring, AI orchestration, the database) runs on the user's PC; the cloud is a mirror + AI proxy. A "SaaS" launch implies at least: licensing/entitlement checks in the *client*, a hosted AI path with metering, and probably moving heavy product research and shared market data to the server (where it can be cached across users, which is also where the unit economics improve).
17. **High: cost per user is driven by AI and is currently uncapped** (see 11.2 #6). Cost drivers: vision analysis of listing photos (multiple images per listing, 8 call sites in `vision.ts`), per-listing scoring (general tier), product research (`lookupProduct`, siblings and variants), comps filtering, bundle breakdown, chat, image generation for category thumbnails. `lowAiMode` (default on) trims this; no per-user cost telemetry exists.
18. **High: no observability**: logs and metrics are in-memory and per-install; no error reporting (no Sentry/crash reporter), no usage analytics, no health dashboards, no cost tracking, no support tooling or remote diagnostics.
19. **Medium: scale limits of the local store.** One user's SQLite DB reached **544 MB** because images are stored as base64 data URIs inside rows; `node:sqlite` is an experimental Node module; no vacuum/retention/pruning policy; some queries read whole tables (for example `getProductSignals` loads every product row on each call); cloud sync does not carry images (no object storage).
20. **Medium: monolith files and global mutable state.** `index.ts` (4.2k lines) holds orchestration, IPC, chat tool execution, research pipelines and mutable module-level state (`config`, `store`, engines, maps); `store.ts` 2.9k lines. This hampers testing and safe change.
21. **Medium: single-process, in-memory concurrency control** (queues, in-flight maps, caches); a crash loses in-flight work; no job persistence on the desktop.
22. **Medium: sync correctness limits**: last-write-wins by timestamp/revision, no conflict UI; only Watches, Feed feedback and Database core fields sync; the Phase 4 job worker is still a **stub** (no AI), the Search Planner is manual and unwired, mobile (Phase 10) deferred.
23. **Low: anti-bot arms race**: the stealth plugin offers no guarantee; Facebook UI changes will periodically break scraping selectors; there is no automated end-to-end test to detect that.

### 11.4 Quality / process

24. **High: almost no automated tests on the desktop** (one file), no lint config, **no CI/CD**, no staging environment, no release process. The author's testing has been ad hoc scripts outside the repo.
25. **Medium: documentation is stale/misleading** (`README.md` and `.env.example` still describe Groq/Gemini keys; cloud README describes only Phases 1-4).
26. **Medium: repository hygiene**: only two commits (both "Checkpoint"); ~77 files modified and many new files **uncommitted** at the time of writing; backups kept as ad hoc snapshot folders; scratch files at repo root (`scratch-test-google.mjs`); `config.json`, `.env`, `data/` are correctly git-ignored but sit inside the working tree with real personal data.
27. **Medium: distribution**: no code signing (Windows SmartScreen warnings), no auto-update channel, no installer customization, Windows-only, requires installed Chrome for best behavior, `postinstall` downloads Playwright Chromium (dev-time).
28. **Low: UI heavy effects** (canvas starfield, particles, custom cursor, sounds) may hurt low-end machines/accessibility; no accessibility audit; no i18n.

---

## 12. SaaS-readiness: the strategic questions

Please evaluate these first, because they decide whether the engineering list matters:

1. **Can this product legally and sustainably be sold as-is?** What are the realistic options: (a) keep the local-scraping design but position as a BYO-account power tool with explicit risk disclosure (liability?); (b) restrict the paid core to **non-Facebook** sources (eBay API, other marketplaces with APIs/feeds) and keep Facebook as an unsupported/experimental add-on; (c) server-side scraping with proxies (worse for ToS and cost); (d) pivot the monetized core to **product intelligence** (the Database/verdict/comps layer), which does not require scraping Facebook.
2. **What should be server-side vs client-side** for a multi-tenant SaaS? (product research cache shared across users, AI metering, eBay keys, WatchCount-like sold data, notification delivery.)
3. **Pricing and entitlements**: what plan limits make sense given the cost drivers in 11.3 #17? What must be enforced client-side vs server-side (the client is trivially modifiable)?
4. **Notification channel**: ntfy.sh public topics vs a first-party push service (FCM/APNs, email, Telegram) with auth.
5. **Data ownership/privacy design** for the shared listings cache and cross-user demand data.
6. **Support and ops model** for a product that depends on fragile third-party UIs.

---

## 13. Appendix

### 13.1 File map (src/main, with roles)

| File | Role |
|---|---|
| `index.ts` | Entry: window, IPC handlers, per-user bootstrap, chat tool executor, product research orchestration, market check, bundle valuation wiring, Discovery feed hooks |
| `scrapeEngine.ts` | Facebook scanner engine: passes, evaluation, vision queue, post-scoring pipeline, Watch evaluation, alerts |
| `scraper.ts` | Playwright page logic: search, listing detail extraction, location selection |
| `browser.ts`, `stealthBrowser.ts` | Chrome launch (persistent profile, stealth), login check, polite delays |
| `scorer.ts` | Search matching, condition detection, pricing (3 pathways), AI general-deal extraction |
| `resaleMath.ts`, `profitGate.ts`, `marketValue.ts`, `placeholderPrice.ts`, `brokenVariant.ts` | Money model, negotiation rules, hidden gems, value estimate, junk-price and broken-variant helpers |
| `bundleBreakdown.ts` | Multi-product listing breakdown and non-linear lot valuation |
| `vision.ts` | Photo analysis (identification, mismatch, flaws, bundles, expert take) |
| `store.ts` | SQLite access and migrations; product matching/signals; Watch tables |
| `chat.ts`, `clynxPersona.ts`, `voice.ts` | Assistant: prompts, tools, streaming; Clynx's personality and app knowledge |
| `webResearch.ts`, `watchcount.ts`, `ebayActive.ts`, `ebayClient.ts`, `ebayEngine.ts`, `ebayNormalize.ts`, `ebayProductFilter.ts`, `compFilter.ts`, `compPhotoCheck.ts` | Web research, WatchCount comps, eBay API, comp filtering |
| `products.ts`, `productIdentity.ts`, `productVerdict.ts`, `discovery.ts` | Product summary generation, model/variant identity, flip verdict, Discovery feed |
| `dealSummary.ts`, `preAlert.ts`, `notify.ts` | Alert ratings/text, pre-alert market check, ntfy delivery |
| `watchScheduler.ts`, `watchFacebook.ts`, `watchMatching.ts`, `watchGeo.ts`, `watchVerify.ts`, `watchOptions.ts`, `watchcount.ts` | Watches |
| `geocode.ts`, `locationDiscovery.ts`, `stateCities.ts`, `usStates.ts` | Location handling |
| `cloudClient.ts`, `watchSync.ts`, `feedbackSync.ts`, `productSync.ts`, `listingIngestSync.ts`, `listingSource.ts`, `facebookMarketplaceSource.ts` | Cloud client and sync services; ListingSource abstraction (adapter exists, not called by the live app) |
| `config.ts`, `types.ts`, `aiMode.ts`, `metrics.ts`, `sellerRisk.ts`, `listingAge.ts`, `recentSearches.ts`, `myStore.ts`, `colors.ts` | Config defaults/migrations, shared types, low-AI mode, in-memory metrics, seller screening, misc |

### 13.2 Key thresholds and constants

Net after eBay fees 84% (keep range 80-86%); min margin 20%; max negotiation 15%; condition multipliers minor 0.6 / major 0.25; placeholder price: ≤ $1 or 4+ digit repeats/sequences; market-check freshness 3 days (`MARKET_RECENT_MS`), timeout 150 s; seller min account age 1 year; listings per location 20; pass wait 2-5 min; photo reference target 10 per product (backfill below 5); sibling discovery cap 6, variants cap 5; bundle weights accessory 0.55 / extra 0.45 / additional unit x0.5, uplift cap 30% of focal, slow seller threshold 14 days, max 4 extras researched per bundle; Discovery feed 40 entries x 40 thoughts; chat tool rounds max 4; OpenAI request timeout 45 s (chat) / 30 s (small calls); credits-exhausted fail-fast pause 10 min.

### 13.3 How to run / test (for reference)

Desktop: `npm run dev`, `npm run build`, `npm run typecheck`, `npm run dist` (Windows installer, unsigned). Cloud: `cd cloud && npm run dev:all` (Postgres+Redis via Docker, migrate, API+worker with hot reload) or `docker compose up -d --build`; `npm test` (needs `.env.test` and real Postgres/Redis).

### 13.4 Glossary

- **Search For**: the user's list of specific products to hunt.
- **Watch**: persistent monitor with its own conditions and alert topic.
- **Database / Library / Discovery**: the product knowledge base; its archive view; its live research feed.
- **WatchCount**: third-party site of eBay *sold* listings (the sold-price source).
- **Hidden gem**: a listing priced too high for the main item alone but worth it once included extras are valued.
- **lowAiMode**: "Save OpenAI credits" (default on).
- **Variant "(For Parts / Broken)"**: a child Database entry valued from broken-item sales.

---

*End of document. If anything here conflicts with what you see in the code, trust the code and tell the author.*
