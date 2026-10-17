# Handoff: Clynx OpenAI web search (read this first)

Repo: bennyellis/clynxai, branch `master-wveebf`. The owner builds and publishes releases on Windows; never publish, register or deploy releases without being told to. Release steps: `docs/RELEASING_BETA.md` (swap in the new version). Never print or ask for API keys or passwords.

## Goal
Clynx chat must research special editions / variants of a product (e.g. New Nintendo 3DS XL Galaxy / SNES editions) using OpenAI web search, show a "Web activity" list of what it searched, and say honestly what it found or why not.

## Current state (all pushed, latest version in package.json = 0.3.0-beta.24)
- Edition research for chat: `src/main/editionResearch.ts`, `editionDiscovery.ts`, tool `research_variants` in `src/main/chat.ts`.
- Web activity list: `withWebActivity` in `src/main/webEvidence.ts`, shown by `ChatStatusLine` in `src/renderer/src/components/ChatExtras.tsx`.
- Variants guard in `chat.ts` (`asksAboutVariants`): a question about editions must run `research_variants` even if another tool already ran.
- DuckDuckGo and Bing are OFF by default (`freeSearchEngines: true` in config.json turns them on). Order now: OpenAI web search, Brave key if set, Wikipedia.
- `saveConfig` (`src/main/config.ts`) keeps `beta13`, `openaiSearchPerHour`, `freeSearchEngines` already on disk; before this, several writers erased the owner's `beta13.openaiSearch` flag.
- Backoff on `rate_limited` in `src/main/openai.ts` so the server does not block the account.

## Unverified (never seen working live)
OpenAI search actually running. The last server check (`ai_usage` rows with kind = 'search') showed 0 rows: no search had ever reached the server, because the app side never asked (flag erased, and chat answered without searching).

## The owner's setup
- Clynx talks to the LAN server at http://10.0.0.81:8788 (containers `clynx-lan-api-1`, `clynx-lan-postgres-1`, `clynx-lan-worker-1`; env file `%USERPROFILE%\ClynxLan\.env.lan`). `AI_SEARCH_ENABLED=true` is set there and confirmed in the running container. The other stack `clynx-cloud-*` (localhost:8787) is a dev stack, not used by the app.
- App config of the owner: `%APPDATA%\Clynx\data\users\1951a4a6-0b08-4c5b-a2c6-b900ac8843d5\config.json`. Needs `"beta13": { "openaiSearch": true }` and `"lowAiMode": false` (Save OpenAI credits off; OpenAI search never runs when it is on).
- The owner's account is the owner on the LAN server (no plan limit); an abuse block ("repeated_refusals") happened once and was cleared with `DELETE FROM api_user_blocks;`.

## Next steps
1. Release Beta 24 (or the next version) with docs/RELEASING_BETA.md; no server update needed.
2. After install check the flag is in config.json, start Clynx, ask: "are there special editions of the New Nintendo 3DS XL?", read the Web activity list.
3. Confirm on the server: `docker exec clynx-lan-postgres-1 psql -U clynx -d clynx_cloud -c "SELECT created_at, status FROM ai_usage WHERE kind = 'search' ORDER BY created_at DESC LIMIT 5;"` (rows with status 200 = OpenAI search ran).
4. Known open bugs: Web activity lines appeared blank once in the Database chat during product research; "create database profiles for all variants" had no real action behind it (the model said Done without creating profiles).
