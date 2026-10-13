# Clynx beta - tester checklist

Tick each box when you have done it. For anything that does not work as written, note **what you did, what you expected, what happened** (a screenshot helps) and send it with a support report (Config > Account > Report a bug).

Name: ____________   Windows version: ________   Chrome/Edge: ________   Clynx build (Config > Account > About): ________

## 1. Installation
- [ ] The installer file's SHA-256 matched the one I was given.
- [ ] Windows showed a SmartScreen warning ("Unknown publisher"); I chose More info > Run anyway. (Expected for this unsigned beta.)
- [ ] Installation finished without errors.
- [ ] A Clynx shortcut exists on the desktop and in the Start menu, and both open the app.
- [ ] Clynx is listed in Settings > Apps as "Clynx (beta)".

## 2. First launch and setup
- [ ] The welcome screen says BETA and shows the version; **Start Clynx** opened the Dashboard.
- [ ] If I had no Chrome/Edge, Clynx told me clearly what to install. (Skip if you have one.)
- [ ] "Open Facebook and log in" opened a browser window; I logged in with my own account; the step ticked by itself.
- [ ] I chose where to look (city or state).
- [ ] I added a first product to the Get started checklist.
- [ ] (Optional) I set up phone alerts, and "Send test notification" reached my phone.
- [ ] (Optional) I saved my own OpenAI key in Config > Account > Your API keys, and the "Add your OpenAI key" notice went away.

## 3. Scanning
- [ ] **Start Scanner** started scanning; the Activity screen shows what it is doing.
- [ ] Listings appeared in the **Feed** within about 10 minutes.
- [ ] Prices, titles and photos in the Feed match what Marketplace shows.
- [ ] Pressing **Stop** stopped it and closed the scanning browser window.
- [ ] If Facebook logged me out or showed a check, Clynx told me in plain words (a notice with a button).

## 4. Product matching (Database)
- [ ] I added a product to the **Database** (for example "PlayStation 5"). Clynx created its entry (with a photo and notes if I have an OpenAI key).
- [ ] A listing for that product in the Feed was recognised as that product (the card names it).
- [ ] A listing for something else was **not** wrongly filed under it. Note any wrong match: listing title, and the product Clynx chose.
- [ ] Variants (for example "Xbox Series S" vs "Xbox Series X", or a game vs its console) were not mixed up.

## 5. Valuation and deals
- [ ] A matched listing shows what the product usually sells for and the profit after fees.
- [ ] The numbers look believable to me (note any that look wrong, with the listing).
- [ ] A clearly good price was flagged as a deal; an ordinary price was not.
- [ ] Deals show a star rating and a short reason I could understand.

## 6. Watches and alerts
- [ ] I created a **Watch** (for example "PS5 under $300") on the Watch screen.
- [ ] The Watch found matching listings, and they appear under that Watch.
- [ ] I got a Windows notification for a deal or Watch match (if notifications are on).
- [ ] (If phone alerts are on) I got a push on my phone, and tapping it opened the listing.
- [ ] I could pause and delete the Watch.

## 7. Settings
- [ ] Config opens, I changed a setting (for example the minimum profit), saved, and it was still set after restarting.
- [ ] The performance modes (Config > Appearance) change how the app feels without breaking anything.
- [ ] Closing the window with unsaved Config changes asked me what to do.

## 8. Database persistence and recovery
- [ ] I closed Clynx completely and reopened it from the shortcut: it went straight in (no welcome screen) and my Database, Feed, Watches and settings were all still there.
- [ ] Config > Account > Database backups: **Back up now** created a backup that is listed.
- [ ] (Optional) **Restore...** worked and Clynx restarted with my data.
- [ ] I restarted the computer, opened Clynx, and everything was still there.
- [ ] I ran a newer installer (when given one) over the old one and kept all my data.

## 9. Errors and recovery
- [ ] I turned off my internet for a minute while scanning; Clynx said so plainly and carried on by itself when it came back.
- [ ] I closed the scanning browser window by hand; Clynx offered "Try again" and recovered.

## 10. Reporting bugs
- [ ] **Config > Account > About** shows the version and build.
- [ ] **Config > Account > Report a bug > Save a support report...** saved a text file.
- [ ] I opened that file and checked it has no password, API key or other private information (tell us if it does!).
- [ ] I sent the report with a description of the problem.

## 11. Uninstalling
- [ ] Uninstalling removed Clynx and its shortcuts.
- [ ] My data was still in `%APPDATA%\Clynx`, as the guide says, and reinstalling brought it all back.

## Overall
What worked well: ______________________________________________

What confused or annoyed me: ______________________________________________

Would I use this regularly? ______  What is missing? ______________________________________________
