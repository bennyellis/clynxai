# Clynx Windows Beta 2 — install guide

Version **0.3.0-beta.2** (Windows 10 or 11, 64-bit). New in Beta 2: you can connect Clynx to a **Clynx server** (for example the one on your main PC) so several computers share one account, one shared AI/eBay service, and automatic updates. **Local mode is still there** — if you do not have a server, Clynx works exactly like Beta 1: everything on this computer, your own keys, no account.

## What you need
* Windows 10 or 11 (64-bit), about 600 MB free.
* **Google Chrome or Microsoft Edge** (Clynx scans Facebook Marketplace through one of them; it does not ship a browser). Edge is part of Windows.
* A Facebook account you are happy to use.
* **Nothing else.** No Docker, Node.js, database or developer tools on this computer.
* For *server mode*: the server's address, e.g. `http://10.0.0.81:8788`, and to be on the same network as the server.

## 1. Check the file (optional, 1 minute)
```powershell
Get-FileHash .\Clynx-Beta-Setup-0.3.0-beta.2.exe -Algorithm SHA256
```
It must equal the value in `BETA2_RELEASE_INFO.txt`. If not, do not run it.

## 2. Install
Double-click the installer. Windows will say *Windows protected your PC* (publisher "Unknown") because the beta is **not code-signed yet**: click **More info → Run anyway** if the checksum matched. Choose the install folder (the default is fine) and finish. Installing over Beta 1 keeps all your data.

## 3. First start — choose how to use Clynx
**A. Server mode (several computers).**
1. Click **I have a Clynx Cloud account**.
2. In **Server address** type the address you were given (for the home server: `http://10.0.0.81:8788`) and click **Test connection**. A green *Connected to …* line means this computer can reach the server and it is a Clynx server. (An address on the internet must start with `https://`; Clynx refuses plain `http://` there so a password is never sent unencrypted across the internet.)
3. **Register** (first time) or **Log in**. Your Owner/customer role and plan come from the server. You need **no OpenAI or eBay key**: the server provides the shared AI/eBay service (the person running the server pays for it and sets the limits).
4. If this computer previously used local mode, tick *Copy my local beta data into this account* to bring your Database, settings and Facebook login across (they are copied, never moved).

**B. Local mode (this computer only).** Click **Start Clynx**. Nothing is sent anywhere. AI features need your own OpenAI key (Config → Account → Your API keys).

## 4. What happens when the server is not reachable
Clynx keeps working with the data on this computer and shows *You're working offline*. It checks again every ~15 seconds and reconnects by itself (Config → Account has **Retry now**). You are not signed out by an outage.

## 5. Updates
In server mode Clynx checks the server for a newer **signed** version, downloads and verifies it in the background, and shows *Clynx x.y.z is ready to install*. It installs **only when you click Restart and install** (Config → Account → Updates). Clynx closes, the installer runs, Clynx reopens on the same data. If a new version fails to start three times, Clynx marks it bad and offers *Go back to the earlier version*. You can always install a newer installer by hand instead, and local mode never checks by itself.

## 6. Your data and keys
* Data: `%APPDATA%\Clynx` (and the folders inside it). Uninstalling keeps it. Updates never touch it, and a Database backup is made just before an update installs.
* Keys you saved in Beta 1 are kept as they were. **Config → Account → Protect my saved keys** (optional) encrypts them with Windows; a backup of the old file is kept until you delete it.
* In server mode Clynx never receives the server's OpenAI/eBay keys; they stay on the server.

## 7. Something not working?
Config → Account → **Report a bug → Save a support report…** (no keys, passwords, listings or photos inside) and send it. For connection problems copy `Test-ClynxConnection.ps1` from the server's `cloud\deploy\windows` folder and run it on this computer.
