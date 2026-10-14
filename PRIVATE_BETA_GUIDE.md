# Clynx private beta — reaching your server from the internet (for you and a few testers)

Goal: from your **second computer** (anywhere), open your private Clynx website over **https**, sign in, download Beta 2, install it, enter your secure Clynx address, sign in — with nothing opened on your router and nothing public except a sign-in page.

```
 second PC / tester ──https──►  Tailscale Funnel (outbound tunnel from THIS PC, real certificate)  ──►  Clynx server on this PC (10.0.0.81:8788)
                                                                                                         │ private-beta GATE: strangers see only a sign-in page
                                                                                                         │ accounts need an invitation; downloads/updates need a sign-in
                                                                                                         └ PostgreSQL / Redis: no ports at all
```

## What is already done on your server (no internet access yet)
* The server code has the **private-beta gate**, **invitations**, authenticated downloads/updates, and a "release draft" tool.
* **Beta 2 is registered as a DRAFT** (nobody can see or download it) with its signed update manifest. You approve and publish it in the console when you decide.
* The tunnel is **not** running. Until you start it, the server is reachable only from your home network, exactly as before — now with the sign-in gate on.

## 1. The access method I recommend (and why)

| Option | Router ports? | Account / cost | Stable address | Gate before the site? | Works with the desktop app? | Verdict |
|---|---|---|---|---|---|---|
| **Tailscale Funnel** | none (outbound tunnel) | free Tailscale account; no domain | yes: `https://<this-pc>.<tailnet>.ts.net`, real certificate | Clynx's own gate (below) | yes — the app sends its normal sign-in | **Recommended: simplest and reliable** |
| Cloudflare Tunnel (named) | none | free account **+ a domain you own** (about $10/year) on Cloudflare DNS | yes, your own name | optional Cloudflare Access (email codes) in front — but then the desktop app needs a service token | yes with a service token | Best long-term; needs a domain and DNS changes |
| Cloudflare quick tunnel | none | none | **no: new random address at every restart** | none | breaks at each restart | Only for a one-off trial |
| Router port-forward + Caddy | **yes** | domain + dynamic DNS | yes | Clynx gate | yes | Rejected: you asked for no router ports |
| Tailscale private network (no Funnel) | none | free | yes | only tailnet devices | **every computer must install Tailscale** | Rejected: the second PC should need only a browser |

Why the gate lives inside Clynx instead of in front of it: a gate in front of the site (Cloudflare Access, a proxy password) would also block the **desktop app**, which is not a browser and cannot answer a browser login page. Clynx's own gate lets the app through with the sign-in the app already has (its access token), and lets browsers through with the website's session cookie. Strangers get a 401 and a tiny sign-in page.

## 2. What you need to do once (about 10 minutes)
I cannot create accounts, change DNS or start a public tunnel for you. Exactly:
1. **Create a free Tailscale account** at https://login.tailscale.com (sign in with Google/Microsoft/GitHub/Apple).
2. **Install Tailscale on this PC** (`winget install Tailscale.Tailscale`, or the installer from https://tailscale.com/download) and sign in.
3. In the Tailscale **admin console → DNS**: make sure **MagicDNS** is on and click **Enable HTTPS**. (This gives your PC a certificate for its `…ts.net` name.)
4. Find this PC's name: in PowerShell `tailscale status` (or the admin console → Machines). It looks like `ben.tail1a2b3.ts.net`. Your private address is `https://ben.tail1a2b3.ts.net`.
5. In PowerShell (from `cloud\deploy\windows`; add `powershell -ExecutionPolicy Bypass -File` in front if scripts are blocked):
   ```powershell
   .\Enable-ClynxPrivateAccess.ps1 -PublicUrl https://ben.tail1a2b3.ts.net     # tells the server its secure address (keeps a backup of the settings)
   .\Set-ClynxTunnel.ps1 -Action Start                                           # THIS is the step that makes it reachable from the internet
   ```
   The first time, Tailscale may print a link asking you to allow **Funnel** for this PC: open it and accept.
6. Test from your phone **on mobile data** (not Wi-Fi): open the address. You should see only a "Private beta" sign-in box.

To switch the internet access off at any time: `.\Set-ClynxTunnel.ps1 -Action Stop`.

## 3. Who can get in
* **Nobody without an account.** A stranger gets a sign-in box. Everything else (website, downloads, update files, API) answers 401. Search engines are told to stay away (`X-Robots-Tag: noindex` on every answer, `robots.txt` disallows all).
* **Accounts need an invitation** (`REGISTRATION=invite`): create codes in the website → **Console → Invitations** (or `.\New-ClynxInvite.ps1 -Email tester@example.com`). A code works once, expires (default 72 h), may be tied to one email, and is shown to you only when created.
* Your own Owner account already exists and keeps working. Passwords: 8+ characters, stored as Argon2id hashes; wrong passwords are throttled per address+email; invitation guesses are throttled per address.
* Disable a tester: Console → Customers. Their website sessions end at once; the desktop's sign-in ends at its next refresh (≤10 minutes).

## 4. The second computer — the whole procedure
1. On the second PC open `https://ben.tail1a2b3.ts.net` (your address) in any browser.
2. Sign in with your Owner account (or **I have an invitation** → email, password, code).
3. Open **Download**. Check it says **Clynx Beta 2**, then click **Download**. (The page shows the SHA-256: `Get-FileHash` should match.)
4. Run the installer. Windows says *Unknown publisher*: **More info → Run anyway** (the beta is not code-signed yet).
5. Open Clynx → **I have a Clynx Cloud account** → Server address: the same `https://ben.tail1a2b3.ts.net` (the Download page shows it with a Copy button) → **Test connection** (green) → sign in / register.
6. Install Chrome or Edge if missing. That is all: no Docker, Node or Git.

Before publishing, only you can see the draft. To release Beta 2 to testers: Console → **Releases → 0.3.0-beta.2 → Approve → Publish** (type the version). The Download page shows it to signed-in testers only.

## 5. Updates (Beta 3 later)
Install Beta 3 as a new draft the same way (`Register-ClynxRelease.ps1 -Installer … -Version 0.3.0-beta.3 -ExpectSha256 …` — it signs the manifest here with your private key), approve and publish it in the console. Every Beta 2 installation that is signed in finds it (its own sign-in passes the gate), downloads and verifies it, and installs when the person clicks **Restart and install**. Signature, checksum and downgrade checks are unchanged.

**Update (Beta 4 onwards, Phase 11.7):** installations from Beta 4 on install new releases by themselves when Clynx is idle (see `PHASE_11_7_AUTOMATIC_UPDATES.md`). In the console, Releases: only the Owner can create, approve, publish, withdraw or **Require** a release; "Require this update" sets a deadline (in hours) by which every online Clynx must have installed it. The Overview page shows how many computers run each version, so you can watch a release arrive.

## 6. Rollback
* Internet off: `.\Set-ClynxTunnel.ps1 -Action Stop`.
* Private mode off (back to Phase 11 behaviour): `.\Disable-ClynxPrivateAccess.ps1` (stop the tunnel first). Accounts and data are untouched.
* Settings undone by hand: `Copy-Item C:\Users\biggt\ClynxLan\.env.lan.bak-<time> C:\Users\biggt\ClynxLan\.env.lan; .\Start-ClynxLan.ps1 -NoBuild`.
* Code: `git checkout phase11.5-start-checkpoint` (before this work) or `phase11-checkpoint`; the server database only gained an `invites` table and update columns (additive).
* A bad release: Console → Releases → Withdraw (it disappears from the Download page and from update checks at once).

## 7. What is not verified (be honest)
* **The real tunnel was never started** (it needs your Tailscale account), so the real certificate chain, the real `ts.net` name and traffic through Tailscale's relays are untested. Everything else about https was tested with a local TLS front that stands in for the tunnel. First-run checklist: `PRIVATE_BETA_CHECKLIST.md`.
* Bandwidth: Tailscale limits Funnel traffic (not published); a 119 MB installer is normally fine.
* The desktop shows a plain-language refusal for an untrusted certificate (tested). Tailscale's certificates come from Let's Encrypt, which the app trusts.
