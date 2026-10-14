# Clynx on more than one computer — the LAN guide

One computer (the **server**, your main PC) runs Clynx Cloud in Docker. Every other computer (a **client**) just installs Clynx and points it at the server. Clients need **no Docker, no Node.js, no database, no developer tools**.

```
 client PC (installed Clynx)  ──── your home/office network (Wi-Fi/Ethernet) ────►  server PC (Docker)
                                                                                    ├─ Clynx Cloud API + website   ← the ONLY thing reachable (one port, 8788)
                                                                                    ├─ PostgreSQL                  ← private, no port
                                                                                    ├─ Redis                       ← private, no port, has a password
                                                                                    └─ background worker
```

* Your server's address on this network is **`http://10.0.0.81:8788`** (your PC "ben" on Wi-Fi). It is the same address for the website and for the Clynx app.
* This is plain `http`, which is fine **inside your own network** and nowhere else. **Never forward port 8788 on your router to the internet.** For internet access see "Later: the internet" below.

---

## 1. On the server PC (one-time)

Docker Desktop must be installed and running (it already is). Open **PowerShell** and go to the scripts folder:

```powershell
cd "C:\Users\biggt\OneDrive\Documents\Claude\Sessions\fb-marketplace-scout\cloud\deploy\windows"
```

The server was already set up and started for you (`Initialize-ClynxLan.ps1`, `Start-ClynxLan.ps1`). To check on it any time:

```powershell
.\Get-ClynxLanStatus.ps1
```

| I want to… | Run (in that folder) |
|---|---|
| Start it (also rebuilds if the code changed) | `.\Start-ClynxLan.ps1` |
| Stop it (data is kept) | `.\Stop-ClynxLan.ps1` |
| See if it is healthy, how many accounts, newest backup | `.\Get-ClynxLanStatus.ps1` |
| Back up the database + uploaded installers | `.\Backup-ClynxLan.ps1`  (add `-IncludeEnv` to also copy the secrets) |
| Check a backup is good without changing anything | `.\Restore-ClynxLan.ps1 -BackupFile <file> -CheckOnly` |
| Restore a backup (safe swap; the old database is kept under another name) | `.\Restore-ClynxLan.ps1 -BackupFile <file> -Yes` |
| Update the server to the code in this folder (backs up first, rolls back by itself if unhealthy) | `.\Update-ClynxLan.ps1` |
| Change secrets (sign everyone out / new passwords) | `.\Rotate-ClynxSecrets.ps1 -What Jwt` (or `Redis`, `Postgres`, `Metrics`, `All`) |
| Make an account the Owner | `.\New-ClynxOwner.ps1 -Email you@example.com` |
| The server PC got a different address | `.\Set-ClynxLanAddress.ps1 -Address <new>` then `.\Start-ClynxLan.ps1` |

(If PowerShell refuses to run scripts: `powershell -ExecutionPolicy Bypass -File .\Start-ClynxLan.ps1`.)

**Where things live.** Secrets and backups are in `C:\Users\biggt\ClynxLan\` — deliberately **outside** the project folder, because that folder syncs to OneDrive. `C:\Users\biggt\ClynxLan\.env.lan` holds the passwords and the key that protects the OpenAI/eBay keys you save in the console; **keep a copy of it somewhere that is not this PC** (a password manager's secure note). Backups are in `C:\Users\biggt\ClynxLan\backups\` — copy them to another disk now and then.

**Keep it running.** In Docker Desktop → Settings → General, turn on *Start Docker Desktop when you sign in*. The Clynx containers restart themselves when Docker starts. The server is only reachable while this PC is on, awake and on the network (so set Windows sleep to *Never* while plugged in, if you want clients to always connect).

**Give the server a fixed address.** In your router, reserve `10.0.0.81` for this PC (a "DHCP reservation"). If the address ever changes, the server refuses to start on the wrong one (so it is never exposed somewhere unintended) and tells you what to run.

## 2. Become the Owner (one-time)

1. Create your account: open the Clynx app → sign-in screen → *Register* (or open `http://10.0.0.81:8788/signup` in a browser). Use your real email; you will use it to sign in.
2. On the server PC run `.\New-ClynxOwner.ps1 -Email you@example.com` and paste the one-time code it prints. (This is the only way to become Owner: it cannot be done from the app or the website. It signs that account out everywhere, so sign in again afterwards.)
3. Sign in on the website (`http://10.0.0.81:8788/login`) → **Console** → **API Integrations**: paste your OpenAI key (and eBay keys if you use them). They are stored encrypted on the server, shown only as a masked hint afterwards, and your customers' computers never receive them. Then open **Spending** and set the daily and monthly limits **before** letting anyone else use the shared AI.

Nothing calls OpenAI or eBay until you do step 3.

## 3. On a second Windows computer

You need: the installer `Clynx-Beta-Setup-0.3.0-beta.2.exe`, and both computers on the **same** network (not a guest network).

1. Copy the installer to the second computer (USB stick, shared folder, anything). Check it is the right file: in PowerShell run `Get-FileHash .\Clynx-Beta-Setup-0.3.0-beta.2.exe -Algorithm SHA256` and compare with the checksum in `beta-release\Clynx-Beta-Setup-0.3.0-beta.2.exe.sha256.txt`.
2. Run it. Windows SmartScreen will say *Windows protected your PC* because the installer is not code-signed yet: click **More info → Run anyway**. Install for yourself (no administrator needed).
3. **Optional but recommended before opening Clynx**: check the network path. Copy `Test-ClynxConnection.ps1` to the second computer and run `.\Test-ClynxConnection.ps1 -Server http://10.0.0.81:8788` in PowerShell. It tells you in plain words if the name/address, the port, or the server itself is the problem.
4. Open **Clynx**. On the welcome screen click **I have a Clynx Cloud account**. Open **Server address**, type `http://10.0.0.81:8788` and click **Test connection**. You should see a green line: *Connected to … (version …)*.
5. Register a new account (or sign in with your Owner account). The first run on this computer registers it as a **device** (visible under My devices on the website).
6. Clynx also needs **Google Chrome or Microsoft Edge** on that computer to scan Facebook Marketplace. It does not ship its own browser.

The second computer keeps its **own** local Database, scanner, Facebook login and Watches; the server provides the account, the shared AI/eBay service, plan limits, sync of your Watches/products between your computers, and updates.

### If a client cannot connect
* `Test-ClynxConnection.ps1` step 1 fails → use the numeric address instead of a name.
* Step 2 fails → the server is off/asleep, Docker is not running, you are on a different network (guest Wi-Fi, "AP/client isolation" on the router blocks computers from talking to each other), or the address changed (`.\Get-ClynxLanStatus.ps1` on the server).
* Step 3 fails → something else answers on that port.
* Windows Firewall: Docker Desktop normally adds its own rule. If a client still cannot connect, run `.\Set-ClynxLanFirewall.ps1` on the server **as administrator** (it allows only your own subnet to reach port 8788; `-Remove` takes it away).

### When the server is off
Clients keep working: the app opens with its own data, says *You're working offline*, and reconnects by itself within about 15 seconds once the server is back. Nothing is lost; syncing resumes.

## 4. Updating

* **The server**: `.\Update-ClynxLan.ps1` (backup → build → restart → health check → automatic return to the previous version if it is not healthy).
* **The app on each computer**: with the server's update key configured (it is), publish the new installer in the website console → *Releases* (upload, approve, download the manifest, sign it **offline** with your update private key, upload the signed manifest, publish). Clients then see *Clynx x.y.z is available*, download and verify it in the background, and install **only when the person clicks Restart and install**. Signature checks cannot be switched off. Manual installers keep working.
* Details and the signing steps: `cloud/DEPLOYMENT.md` → *Automatic desktop updates*.

## 5. Later: the internet (prepared, not started)

`docker-compose.https.yml` + `Caddyfile.https` run the same server behind Caddy with a real HTTPS certificate, publishing only ports 80/443. Do **not** use the LAN address from outside your home. The checklist (domain name, port forward 80/443 only, SMTP email, Owner password, spending limits, backups off the PC, legal pages, rate-limit review) is in `cloud/DEPLOYMENT.md` → *Putting Clynx on the internet* and in `PHASE11_FINAL_REPORT.txt`.

## What is and is not exposed right now

| | Reachable from other computers? |
|---|---|
| Clynx Cloud API + website, port 8788 | Yes — only on `10.0.0.81` (not on VPN/WSL/other adapters), requires an account |
| PostgreSQL (LAN server) | **No** — not published at all |
| Redis (LAN server) | **No** — not published at all, password protected |
| Developer stack (`docker-compose.yml`: 8787, 5432, 6379) | **No** — bound to this PC only (`127.0.0.1`) since Phase 11 |
