# Clynx beta - install guide (Windows)

Thank you for testing Clynx. This guide takes about 10 minutes. Everything Clynx does happens on **your** computer; there is no account to create.

Version: **0.3.0-beta.1** (Windows 10 or 11, 64-bit). Check the build you were given against the checksum in `BETA_RELEASE_INFO.txt`.

## What you need
- Windows 10 or 11 (64-bit), about 600 MB free disk space.
- **Google Chrome or Microsoft Edge.** Clynx scans Facebook Marketplace through one of them. Edge is already part of Windows 10/11, so you almost certainly have it. Clynx does not ship its own browser.
- A Facebook account you are happy to use for this (see "About Facebook" below).
- Optional but needed to get *deals judged*: your own OpenAI API key (see "API keys").
- Nothing else. You do **not** need Node.js, npm, VS Code, Git or any developer tools.

## 1. Check the file (optional, 1 minute)
Open PowerShell in the folder with the installer and run:

```powershell
Get-FileHash .\Clynx-Beta-Setup-0.3.0-beta.1.exe -Algorithm SHA256
```

The long value must equal the SHA-256 in `BETA_RELEASE_INFO.txt`. If it does not, do not run the file; ask whoever sent it.

## 2. Install
1. Double-click `Clynx-Beta-Setup-0.3.0-beta.1.exe`.
2. **Windows will probably warn you** ("Windows protected your PC", publisher "Unknown"). This beta is **not code-signed** (a signing certificate costs money and is not set up yet), so SmartScreen warns about every unsigned download. If you trust the person who sent it and the checksum matched: click **More info**, then **Run anyway**.
   - Some antivirus programs may also flag a brand-new unsigned program. If yours does, tell us which one and what it said; do not disable your antivirus.
3. Choose "Install for me only" (the default), keep or change the folder, click **Install**, then **Finish**.
4. You now have a **Clynx** shortcut on the desktop and in the Start menu.

## 3. First launch
1. Open Clynx. You see a welcome screen marked **BETA**. Click **Start Clynx**. (If it warns that Chrome or Edge is missing, install Google Chrome from google.com/chrome and restart Clynx.)
2. The Dashboard shows a **Get started** checklist:
   - **Open Facebook and log in** - a Chrome/Edge window opens on Facebook. Log in with your own account in that window (Clynx never sees or stores your password; the browser keeps the login in a folder on your computer). The tick appears by itself when you are in. Also set your Marketplace location in that window if Facebook asks.
   - **Choose where to look** - pick your city or state.
   - **Add a first product** - a thing you want to find deals on.
   - **Set up phone alerts** (optional) - Clynx can push deals to your phone with the free ntfy app. Press **Generate private topic**, subscribe to that topic in the ntfy app, then **Send test notification**.
3. Press **Start Scanner** on the Dashboard.

## API keys (so Clynx can judge listings)
Clynx ships with **no keys**. Without an OpenAI key it still finds listings and prices the ones that match a product already in your Database, but it cannot decide whether *other* listings are deals, and says so in a notice on the Dashboard.
- Get a key at platform.openai.com (OpenAI bills you directly; Clynx is set to save credits by default).
- In Clynx: **Config > Account > Your API keys** > paste the key > **Save key**. It is stored only on your computer and is never shown again or included in reports.
- eBay keys (optional, for eBay sold prices and eBay searching) go in the same place.
- You can remove a key at any time with **Remove saved key**.

## What leaves your computer
- Facebook pages, through your own Chrome/Edge window (the same as browsing yourself, but automated).
- If you add an OpenAI key: listing titles, descriptions and photos are sent to OpenAI to be judged.
- If you add eBay keys: product searches go to eBay. Clynx also looks up sold prices on public web pages.
- If you set a phone-alert topic: the deal text goes to ntfy.sh under that topic. With no topic, nothing is sent.
- Nothing is sent to Clynx's developers automatically. There is no tracking. A support report is a file **you** choose to save and send.

## About Facebook
Clynx reads Marketplace the way you would, but automatically, using your own login. Facebook's terms restrict automated access, and Facebook can ask you to verify your identity or limit an account that behaves unusually. Clynx keeps a slow, human-like pace, but **you use it at your own risk**. Prefer an account you can afford to have restricted, and stop and tell us if Facebook shows any warning.

## Where your data lives
Everything is in `%APPDATA%\Clynx` (paste that into the File Explorer address bar). Your Database is in `data\users\local-beta`. Each tester has their own, starting empty.

## Backups and restore
Clynx saves a safety copy of your Database about once a day (and when you press **Back up now**) in `data\users\local-beta\backups`. To go back: **Config > Account > Database backups > Restore...** (Clynx restarts; the Database you had before is kept next to it).

## Updating
There is no automatic update. When you receive a new installer, just run it: it installs over the old version and **keeps all your data and settings**.

## Uninstalling
Settings > Apps > **Clynx (beta)** > Uninstall (or the Start menu entry). This removes the program, the shortcuts and the uninstall entry. **Your data is kept** in `%APPDATA%\Clynx` so that reinstalling picks up where you left off. To remove it completely, delete that folder yourself after uninstalling (this also removes your Facebook login for Clynx and any saved API keys).

## Something not working?
1. **Config > Account > Report a bug > Save a support report...** and save the file.
2. Send it, with two sentences about what you were doing, to whoever gave you the beta.
   The report lists the version, your settings (secrets removed), the browser Clynx found, recent scanner warnings and technical events. It never contains passwords, API keys, cookies, session files, listings or photos.
3. **Config > Account > About** shows the exact version and build to quote.
4. The Dashboard shows "needs attention" notices (browser missing, Facebook logged out, scanner failing, no API key) with a button for each.
