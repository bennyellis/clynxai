# Private beta — manual checklist for the first real run (internet + second PC)

What I could not do (no Tailscale account, no second computer): everything marked ⬜ below. Everything else was tested (see `PHASE115_FINAL_REPORT.txt`). Tick each line; if one fails, the right-hand column says what to look at.

## A. One-time setup (this PC) — details in `PRIVATE_BETA_GUIDE.md` §2
| ⬜ | Step | Expected | If not |
|---|---|---|---|
| 1 | Tailscale account created, installed on this PC, signed in | `tailscale status` lists this PC | — |
| 2 | Admin console → DNS → MagicDNS on, **Enable HTTPS** | a `…ts.net` name for this PC | funnel start will say HTTPS is not enabled |
| 3 | `.\Enable-ClynxPrivateAccess.ps1 -PublicUrl https://<this-pc>.<tailnet>.ts.net` | "access = private, registration = invite" | settings backup `.env.lan.bak-…` is kept |
| 4 | `.\Set-ClynxTunnel.ps1 -Action Start` (accept the Funnel link if Tailscale asks) | prints the https address | `tailscale funnel status` |

## B. From the internet (use your phone on mobile data, not your Wi-Fi)
| ⬜ | Step | Expected | If not |
|---|---|---|---|
| 5 | Open `https://<address>` | padlock, a small "Private beta — Sign in" box, **nothing else** | no padlock → HTTPS not enabled in Tailscale; blank page → tunnel not started |
| 6 | Open `https://<address>/download` and `/releases/latest` | the same sign-in box / `{"error":"private_beta"}` | if you see the website, the gate is not on: `Get-ClynxLanStatus.ps1` and `/server/info` should say `"access":"private"` |
| 7 | Search the address in Google/Bing after a day | not indexed (and `/robots.txt` says `Disallow: /`) | — |
| 8 | Try 10 wrong passwords | "Too many attempts" after the 8th | — |

## C. Release Beta 2 to testers (the step I did NOT do for you)
| ⬜ | Step | Expected |
|---|---|---|
| 9 | Website → Console → **Releases** → `0.3.0-beta.2` (a draft is already there, with its signed manifest) → check SHA-256 `1ab29e15…c8dc8`, size 124,737,268 → **Approve** → **Publish** (type `0.3.0-beta.2`) | status "published" |
| 10 | Console → **Invitations** → create a code for each tester (email optional) | code shown once |

## D. The second computer (nothing installed except a browser)
| ⬜ | Step | Expected | If not |
|---|---|---|---|
| 11 | Open `https://<address>`, sign in (your Owner account, or "I have an invitation") | the Clynx website | invitation errors say "may be wrong, used, expired, or for a different email" |
| 12 | **Download** page | title **Clynx Beta 2**, version 0.3.0-beta.2, Windows x64, 119 MB, SHA-256, notes, the SmartScreen warning, your server address with Copy | — |
| 13 | Download, then `Get-FileHash .\Clynx-Beta-Setup-0.3.0-beta.2.exe -Algorithm SHA256` | equals the page | re-download |
| 14 | Run it → *More info → Run anyway* → install **for the current user only** (not "anyone who uses this computer") | installs, no UAC prompt | an "all users" install makes later updates ask for administrator rights each time |
| 15 | Clynx → *I have a Clynx Cloud account* → Server address = your https address → **Test connection** | green "Connected to …"; (private server) | "certificate" message → the address is not the Tailscale one; "did not answer" → tunnel/PC off |
| 16 | Sign in (Owner), or Register with an invitation code | Dashboard; Config → Account shows the server + "Connected"; Owner shows "Owner — Full Access" | — |
| 17 | Website → My devices | the second PC is listed | — |
| 18 | Stop the tunnel (`Set-ClynxTunnel.ps1 -Action Stop`) for a minute, then start it | the app shows "working offline" within ~1 min, reconnects by itself within ~15 s of the tunnel returning | — |
| 19 | Later: publish Beta 3 (`Register-ClynxRelease.ps1 …`, approve, publish) | the second PC shows "Clynx 0.3.0-beta.3 is ready to install" (no sign-in prompt, no browser) → Restart and install → reopens on the new version | the app must be signed in; the update check needs its sign-in |

## E. This PC (before anything else)
| ⬜ | Step | Why |
|---|---|---|
| 20 | Remove the stale per-machine test registration: Settings → Apps → **Clynx (beta)** → Uninstall (click Yes on the UAC prompt), or run `cloud\deploy\windows\Remove-StaleClynxTestInstall.ps1` as administrator | While it exists, every Clynx installer on this PC asks for administrator rights |
