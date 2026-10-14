# Clynx Cloud — operations runbook (the LAN server on Windows + Docker)

Everything here is a script in `cloud/deploy/windows/` (Windows PowerShell 5.1 or 7). They never delete a Docker volume, never touch the developer stack (`docker-compose.yml`), and ask you to confirm anything destructive. Secrets and backups live in `%USERPROFILE%\ClynxLan\` (outside the OneDrive-synced project folder).

```powershell
cd "C:\Users\biggt\OneDrive\Documents\Claude\Sessions\fb-marketplace-scout\cloud\deploy\windows"
```

## Daily operations

| Task | Command | What it does / checks |
|---|---|---|
| Start | `.\Start-ClynxLan.ps1` | Refuses to start if this PC no longer has the address in `.env.lan` (so the server is never exposed on the wrong network). Builds the image if needed, starts PostgreSQL, Redis, the API (+ website) and the worker, waits for `/health/ready`, prints the address. Existing data is kept. |
| Stop | `.\Stop-ClynxLan.ps1` (`-Down` also removes the containers) | Data stays in the Docker volumes. |
| Health | `.\Get-ClynxLanStatus.ps1` | Containers, readiness (database + Redis), version, shared services, queue depth and request counts (from `/metrics`, token from `.env.lan`), number of accounts, age of the newest backup, which ports are listening and on which address (warns if PostgreSQL/Redis listen beyond this PC). |
| Logs | `docker compose -p clynx-lan -f ..\..\docker-compose.lan.yml --env-file $env:USERPROFILE\ClynxLan\.env.lan logs --tail 100 api` | (set `$env:CLYNX_ENV_FILE` and `$env:LAN_BIND` first, as the scripts do) |

## Connecting client computers
See `LAN_SETUP_GUIDE.md`. In short: install `Clynx-Beta-Setup-<version>.exe` → *I have a Clynx Cloud account* → Server address `http://10.0.0.81:8788` → *Test connection* → register/sign in. On a client that cannot connect run `Test-ClynxConnection.ps1 -Server http://10.0.0.81:8788`.

## Backups
* `.\Backup-ClynxLan.ps1` — consistent `pg_dump` (gzip-verified), the uploaded installers (`releases` volume), and a SHA-256 list. Keeps the newest 14 sets (`-Keep n`). `-IncludeEnv` also copies `.env.lan` (**secrets**: store that copy privately, off this PC).
* Schedule it (Task Scheduler → *Create Basic Task* → daily → Program `powershell.exe`, arguments `-NoProfile -ExecutionPolicy Bypass -File "<folder>\Backup-ClynxLan.ps1"`), and copy `%USERPROFILE%\ClynxLan\backups` to another disk/computer. A backup on the same disk does not survive that disk failing.
* Always back up **before** an update (the update script does it for you) and before rotating secrets.

## Restore
1. `.\Restore-ClynxLan.ps1 -BackupFile <...sql.gz> -CheckOnly` — loads the backup into a scratch database, reports how many accounts/migrations it holds, removes the scratch database. The running server is not touched. **Do this once now and then**: an untested backup is a hope, not a backup.
2. `.\Restore-ClynxLan.ps1 -BackupFile <...sql.gz> -Yes` — takes a safety backup of the current database, stops api+worker, **renames** the live database to `clynx_cloud_before_restore_<time>` and the restored copy into its place, restarts, checks health. Nothing is dropped: to undo, stop api+worker and rename the databases back. Drop the old one yourself later (`DROP DATABASE …`) when you are sure.
3. Uploaded installers: extract `…releases.tgz` into the `releases` volume (`docker run --rm -v clynx-lan_releases_data:/data -v "<backup folder>":/b alpine tar xzf /b/<file>.releases.tgz -C /data`). Their SHA-256 values are also stored in the database, so a restored file can be verified in the console (*Re-check checksum*).
4. The encryption key for saved OpenAI/eBay keys is in `.env.lan` (`CREDENTIALS_ENCRYPTION_KEY`). A database restored **without** the matching key shows those credentials as "needs re-entering"; nothing else is lost.

## Updating the server
`.\Update-ClynxLan.ps1` — backup (`pre-update`) → tag the running image `…:previous` → build the new image → restart (migrations run at start under a database lock; they only **add** tables/columns) → wait for health → if unhealthy, switch back to `…:previous` automatically and say so. `-Pull` runs `git pull --ff-only` first. Clients stay connected through the restart (they show *working offline* for a few seconds and reconnect by themselves; verified).
Rollback beyond that: `git checkout <older tag>`, `.\Update-ClynxLan.ps1`; migrations are additive, so the older code runs against the newer schema; if it ever must be reversed, restore the pre-update backup (above).

## Rotating secrets
`.\Rotate-ClynxSecrets.ps1 -What Jwt|Redis|Postgres|Metrics|All` — keeps `.env.lan.bak-<time>` (the **old** secrets; delete it when satisfied), changes the value(s) (for `Postgres` it first runs `ALTER USER … PASSWORD` inside the database), recreates the affected containers, checks health.
* `Jwt` signs **everyone** out (they sign in again). Rotate it if you think a token or the file leaked.
* `Postgres`/`Redis`: do after a person who had the file leaves, or on a schedule.
* **The credential-encryption key** (`CREDENTIALS_ENCRYPTION_KEY`) is rotated by hand because the saved OpenAI/eBay keys must be re-encrypted: (1) back up; (2) in `.env.lan` move the current value to `CREDENTIALS_ENCRYPTION_KEY_PREVIOUS` and put a new `openssl rand -base64 32` value in `CREDENTIALS_ENCRYPTION_KEY`; (3) `.\Start-ClynxLan.ps1 -NoBuild`; (4) in the website console re-save each credential (OpenAI, eBay); (5) remove the `_PREVIOUS` line and restart.
* **The update signing key** lives on your machine (`C:\Users\biggt\ClynxKeys\update-signing\`), not on the server. If it were lost, no further automatic updates can be signed (clients refuse anything else): ship a new installer by hand that embeds a new public key. If it leaked, do the same and withdraw published releases. **Back it up offline now.**
* Secrets you typed into the website (OpenAI key, eBay credentials): rotate in the console → *API Integrations* (Owner only).

## Monitoring
* `Get-ClynxLanStatus.ps1` by hand or on a schedule; Docker marks the API container `unhealthy` if `/health` fails.
* Website console → **Health**: database, Redis, queue, email outbox, request counts. **Spending**: today's/this month's estimated AI cost per customer and globally, abuse flags, the emergency switch.
* `GET /metrics` (bearer `METRICS_TOKEN`) for any external monitor. `GET /health/ready` returns 503 when the database or Redis is down.

## Recovering from failures

| Symptom | Likely cause | Do this |
|---|---|---|
| Clients say *working offline* | Server PC asleep/off, Docker not running, containers stopped, address changed | `.\Get-ClynxLanStatus.ps1`; `.\Start-ClynxLan.ps1`; if the address changed: `.\Set-ClynxLanAddress.ps1 -Address …` |
| `Start-ClynxLan.ps1`: "no longer has the address" | Router gave this PC a new address | DHCP reservation in the router, then `Set-ClynxLanAddress.ps1` |
| API container restarts in a loop | Bad `.env.lan` value or migration error | `docker compose … logs api`; fix the value; or `.\Update-ClynxLan.ps1` returns to the previous image |
| `Update` rolled back | New code unhealthy | read the logs, fix, run again; data is untouched |
| Everyone signed out | JWT secrets rotated, or Owner granted | expected; sign in again |
| Database damaged / lost volume | Disk problem | install Docker, `Initialize` is not needed (`.env.lan` is backed up), `Start-ClynxLan.ps1`, then `Restore-ClynxLan.ps1 -BackupFile … -Yes` |
| `.env.lan` lost | — | without `CREDENTIALS_ENCRYPTION_KEY` the saved OpenAI/eBay keys cannot be read: re-enter them in the console. Passwords are replaced by `Initialize` + a database password reset (`ALTER USER`) — or restore `.env.lan` from your private copy. |
| Owner account lost | — | on the server: `.\New-ClynxOwner.ps1 -Revoke -Email <old>` then register a new account and `New-ClynxOwner.ps1` |
| A client is stuck after a bad update | New version will not start | it detects 3 failed starts, marks that version bad, and offers *Go back to <version>* (needs the earlier build still published on the server, or the kept installer). Otherwise install the previous installer by hand; data is untouched. |
| Disk filling up | Backups, Docker images | `docker image prune` (old images only), move old backups off the PC |

## What the scripts will never do
Delete a Docker volume, drop a database without renaming/backing up first, publish a port other than the API's, open anything to the internet, send data anywhere, or change the developer stack.
