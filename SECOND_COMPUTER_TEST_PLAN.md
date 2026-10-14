# Second-computer test plan (real cross-computer validation)

I had only one Windows computer, so everything below is **still to be confirmed on a real second PC**. Everything else in `PHASE11_FINAL_REPORT.txt` was verified on the server PC, with the installed Beta 2 reaching the Docker server through the PC's Wi-Fi address (`10.0.0.81`), which proves the network binding and the app but not another computer's firewall, Wi-Fi settings, antivirus or SmartScreen.

**Needs:** the server PC on and awake with Docker running (`.\Get-ClynxLanStatus.ps1` shows "ready"); a second Windows 10/11 PC with Chrome or Edge, on the same Wi-Fi/Ethernet (not a guest network); the installer + checksum (`beta-release\`); this sheet. **Do not use real paid API keys; the server has none configured unless you add them.**

Mark each line ✅ / ❌ and note anything odd. Where a step fails, the right-hand column is the first thing to check.

| # | On the second PC | Expected | If not |
|---|---|---|---|
| 1 | Copy `Clynx-Beta-Setup-0.3.0-beta.2.exe`; `Get-FileHash … -Algorithm SHA256` | equals `BETA2_RELEASE_INFO.txt` | re-copy |
| 2 | Run the installer (More info → Run anyway) | installs without administrator rights; Start-menu + desktop shortcut | note the exact SmartScreen / antivirus message |
| 3 | PowerShell: `.\Test-ClynxConnection.ps1 -Server http://10.0.0.81:8788` (copy the script from the server's `cloud\deploy\windows`) | 3 green steps, "Clynx Cloud (home server)" | step 1 = use the number; step 2 = same network? guest Wi-Fi? server asleep? firewall (`Set-ClynxLanFirewall.ps1` on the server, as administrator) |
| 4 | Open Clynx → *I have a Clynx Cloud account* → Server address `http://10.0.0.81:8788` → *Test connection* | green "Connected to …" | the message says why |
| 5 | Register `second-pc@…` (any address) | lands on the Dashboard | — |
| 6 | Server PC: website `http://10.0.0.81:8788` → sign in as the **Owner** → Console → Customers | the new account is listed; | — |
| 7 | Config → Account | server address + "Connected"; plan "Free" | — |
| 8 | Sign out, sign in as the **Owner** account on the second PC | "Owner — Full Access" | the account must be made Owner on the server first (`New-ClynxOwner.ps1`) |
| 9 | Server PC website → My devices | both computers listed; removing the second one signs it out within ~10 minutes | — |
| 10 | Config → Facebook account → log in (a throw-away account if you prefer) → start a search for something cheap | listings appear (local scanning works on this PC, with its own browser) | Chrome/Edge missing → the Dashboard says so |
| 11 | Add a Watch with a phone-alert topic (ntfy) you control; let it find a match | the alert arrives (the alert goes from the second PC to ntfy, not through the server) | — |
| 12 | Close Clynx, reopen | signed in automatically; same Database/Watch | — |
| 13 | **Server PC:** `.\Stop-ClynxLan.ps1` | within ~1 minute the second PC shows "You're working offline"; scanning/Database keep working | — |
| 14 | **Server PC:** `.\Start-ClynxLan.ps1` | within ~30 s the offline notice disappears by itself; Config → Account says Connected | click *Retry now* |
| 15 | **Server PC:** `.\Update-ClynxLan.ps1` while the second PC is open | second PC shows offline briefly then recovers; nothing lost | — |
| 16 | AI check (no paid call unless the Owner entered a key): ask the assistant a question | without a company key: "Clynx's AI service is temporarily unavailable" (this proves the shared route; **no OpenAI call is made**). With a key entered by the Owner and limits set, answers appear and the Owner's *Spending* page shows usage attributed to this account | — |
| 17 | Updates: publish a test release per `cloud/DEPLOYMENT.md` → *Automatic desktop updates* | second PC shows "Clynx x.y.z is ready to install" → Restart and install → reopens on the new version, data intact; *Go back to …* works | — |
| 18 | Uninstall from Settings → Apps | program removed; `%APPDATA%\Clynx` kept | — |

When you are done, send me the ✅/❌ list plus the support report (Config → Account → Report a bug) from any ❌ line.

## What each result proves
* Rows 3–5, 7: a second computer can reach the server and authenticate over the network.
* Rows 6, 8–9: device registration, Owner recognition and device revocation across computers.
* Rows 10–12: local scanning, Watch alerts and persistence on a computer that never had development tools.
* Rows 13–15: disconnection, automatic reconnection and server updates with a real client.
* Row 16: shared API routing. Row 17: signed update delivery to another computer.
