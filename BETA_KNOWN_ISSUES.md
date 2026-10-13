# Clynx beta 0.3.0-beta.1 - known issues and limits

Read this before reporting something that is listed here.

## About this build
- **Unsigned installer.** Windows SmartScreen shows "Windows protected your PC / Unknown publisher" until a code-signing certificate is bought and set up. Antivirus programs may also be suspicious of a new unsigned program. Verify the SHA-256 and only run the file from the person who gave it to you.
- **Windows 10/11, 64-bit only.** There is no Mac or Linux build. (macOS support exists as configuration but has never been built or tested.)
- **No automatic updates.** Install new versions by running the new installer over the old one. Your data is kept.
- **Not tested on a clean Windows machine or virtual machine** by the developer (none was available). It was tested by installing the real installer on a development PC under a throwaway profile, with developer tools removed from the search path.

## Needs things Clynx does not include
- **Google Chrome or Microsoft Edge is required** for scanning. Clynx does not carry its own browser.
- **No API keys are included.** Without your own OpenAI key, Clynx collects listings and prices those that match a product already in your Database, but cannot judge other listings, research new products, or use the assistant. Most "skipped / not judged" messages mean this. You pay OpenAI directly for your own usage.
- **eBay sold prices and eBay searches need your own eBay developer keys.** Without them Clynx falls back to what is already in your Database.

## Behaviour you may notice
- **A new Database is empty**, so at first almost nothing can be priced from the Database. It fills as you add products, and (with an OpenAI key) as Clynx researches what it sees.
- **First location setup can be slow.** Choosing "whole country" makes Clynx look up 48 cities on Facebook one at a time at a deliberately slow pace (about 12-15 minutes). A single city or state is much faster.
- **Facebook can change its pages at any time**, which can make scanning find nothing until Clynx is updated. Clynx says "found 0 listings" and shows a notice rather than failing silently.
- **Facebook may log you out or ask for a security check** if it dislikes automated browsing. Clynx reports this and stops; it never tries to get around a Facebook check. Using this beta is at your own risk (see the install guide).
- **The scanning browser window** may appear and disappear while scanning; do not close it by hand (Clynx recovers if you do).
- **Deal quality is judged by AI and by sold-price data** and can be wrong. Treat alerts as "worth a look", not as advice.
- **Alerts to your phone need the free ntfy app** and a topic you set up. With no topic set, nothing is sent.
- **The identity safeguard and Database Review "Apply"** (advanced matching correction tools) are **off** in this beta on purpose.

## Not in the beta
- No Clynx Cloud account, plan or billing (local mode only). The Account section says so.
- No password reset, because there is no account.
- No sync between computers.

## Data and privacy notes
- Uninstalling **keeps** `%APPDATA%\Clynx` (your Database, settings, Facebook login for Clynx, saved API keys). Delete the folder yourself for a full removal.
- API keys are stored in a plain text file (`%APPDATA%\Clynx\.env`) on your computer, readable by anyone who can read your user folder. Use a key with a spending limit set at OpenAI.
- The support report removes secrets, but read it before sending.

## Testing that was NOT done
- No test against the real Facebook (scanning was tested against a local imitation of Marketplace so that nobody's account was involved).
- No test against real OpenAI, eBay or ntfy services with real keys.
- No long-running (days) test, no low-memory or slow-disk test.
- Windows Defender / third-party antivirus behaviour was not tested.
