# Clynx

A desktop app that browses Facebook Marketplace within your set radius,
actively searches for the specific things you've told it to find (your
**Search For** list), also flags standout deals outside that list using
the AI's own judgment, and pushes a phone notification (via
[ntfy](https://ntfy.sh)) when it finds one. Everything — Search For items,
prices, thresholds, seller-risk filters, your Groq key, live activity, and
past listings — is managed from the app's UI, not by hand-editing JSON.

Built with Electron + React + TypeScript (`electron-vite`).

## Read this before running it

- **This automates your personal Facebook account.** Facebook's Terms of
  Service prohibit automated data collection from the site, and there is a
  real chance Facebook flags or restricts the account this runs as if it
  scrapes too aggressively or too often. This tool tries to keep the pace
  modest (randomized delays, a single browser session, no parallelism) to
  reduce how obviously automated it looks, but nothing here guarantees
  your account stays safe. Consider using an account you're willing to
  lose access to, not your primary one.
- **Location + radius must be set inside the app's own browser window**,
  not your regular browser. Facebook appears to store the distance filter
  locally to the browser rather than on your account, so setting it
  elsewhere won't carry over to the automated profile. Use **Dashboard →
  Open Facebook Marketplace** — that opens the exact browser profile the
  scraper reuses (`browser-profile/`); set your distance filter there.
- **Search For reference prices are only as good as what you enter.**
  Nothing in this app knows today's actual resale value for an Xbox or an
  iPhone — that number changes constantly. Set real numbers from eBay sold
  listings, StockX, or your own sales history in Config, and revisit them
  periodically. Anything left at $0 is ignored, never treated as
  "infinitely undervalued."
- **Two deal tiers, different trust levels:**
  - **Deal** — the listing matched an item on your Search For list. The
    discount-percent math is plain arithmetic against the price *you*
    vetted. The AI only judges whether it's a genuine match and whether
    the description mentions damage/missing parts.
  - **General deals (unverified pricing)** — the listing didn't match
    anything you configured, but the AI thinks it's a steal based on its
    own general sense of typical value. There's no vetted price behind
    this, so it's meaningfully less trustworthy — verify the price
    yourself before acting on one. Configurable (including turning it
    off entirely) in Config.
- **"Train the AI" here means feedback-driven few-shot prompting, not
  fine-tuning.** Groq's free tier doesn't support actually training a
  model. Marking a listing 👍/👎 in the Feed screen stores that as a
  labeled example, and the most recent handful of your labels get fed
  back into future scoring prompts to help calibrate borderline calls.
- **Seller-risk filtering only checks objective, transaction-relevant
  signals** — account age, rating, sales history, profile photo presence.
  It deliberately does not (and won't) filter by inferred sex, apparent
  age, or name/ethnicity — see Config → Seller risk filters.
- **Multi-location rotation.** Facebook still seems to bias results toward
  whatever location is currently set even with a large radius, so with more
  than one URL in Config → Browse locations, the scraper switches to the
  next one every `listingsPerLocation` listings evaluated (default 10).
  With just one URL, nothing changes from before.
- **"Discover locations" auto-resolves city names to real URLs** by
  driving Facebook's own location picker — spread across major US metros,
  never a fabricated location ID. This is the single most experimental
  piece of automation in the app: I was never able to verify Facebook's
  location-picker UI against a live logged-in session while building it,
  so the selectors are best-effort accessibility-pattern guesses. It's
  conservative on failure (skips a city rather than risking the wrong
  one) — check the per-city results after running it, and fall back to
  capturing a URL by hand (same as before) for any that don't resolve.
- **Every Search For item is genuinely searched for now — fixed a real
  bug.** If you added an item with just a name and price (no separate
  match keywords typed in), it used to silently do nothing at all — no
  active search, no passive matching either, since both needed at least
  one keyword to work with. It now falls back to the item name itself
  when you haven't typed explicit keywords, so that's fixed. Also added
  `exact=false` to the constructed search URL, matching the format
  originally verified working by hand — its absence may have been making
  results broader/less targeted than intended.
- **The chat assistant (Dashboard) can actually act on requests now** —
  ask it to find/track/watch/search for something and it can add it to
  your Search For list, or add a custom instruction, for you — not just
  talk about it. Its only two abilities are exactly that (both
  deal-finding config changes); it can't touch API keys, notifications,
  seller-risk filters, or start/stop scraping. When it adds something, it
  also logs a line in the activity feed and the change is saved
  immediately — check Config if you want to review or adjust what it
  added. If it adds a Search For item without a price (because you didn't
  give it one), that item won't trigger deal alerts until you set a real
  resale price for it yourself.
- **Every Search For item is actively searched — no separate toggle.**
  Each one gets a dedicated keyword search at every location, every
  cycle, on top of being matched passively if encountered during normal
  browsing. There used to be a per-item checkbox for this; it's gone —
  adding something to Search For means you want it looked for, so that's
  now just what happens.
- **Live AI narration.** The activity feed now gets short, auto-generated
  one-liners from the AI as it works — an excited aside when it finds a
  deal, a brief recap after finishing a batch of listings. This is
  separate from the chat replies to your own messages (visually distinct
  in the feed) and is purely commentary — it never changes scoring or
  config on its own, only the chat tools do that.
- **eBay sold-comps on every deal found.** When a listing gets flagged as
  a deal (Search For match or general), it automatically gets an eBay sold-listings
  lookup in the background — average price, sample count, and a rough
  "sells about every N days" turnover estimate — shown right on its Feed
  card. Same best-effort/logged-out lookup as the manual "Check eBay"
  button, so it inherits the same limits: eBay often blocks it or asks for
  a sign-in, and the turnover number specifically is a rough estimate from
  whatever sold-date text it can parse off the results page (frequently
  none) — it needs at least 3 dated samples before showing anything, and
  is the spread between oldest/newest dated sale, not real per-item
  listing-to-sale time (that would need visiting every individual sold
  listing, which isn't worth the added scraping load). It runs in its own
  throwaway browser and never delays the actual deal notification, which
  fires immediately — the comps show up on the card a few seconds later
  once (if) they resolve. Toggle it off in Config → Search For if it's
  too slow or noisy for you.
- **eBay comps are now precision-filtered, up to 50 samples.** Three
  changes together: (1) searches use the canonical Search For item name
  (e.g. "Xbox Series X 1TB") instead of the raw, messy Facebook listing
  title — that mismatch was the main reason loosely-related items were
  showing up; general-tier deals have no canonical name, so those still
  use the listing title and are inherently less precise. (2) the eBay
  query is quoted for exact-phrase search. (3) every significant word of
  the query must actually appear in each sold listing's own title before
  it counts — a same-product-line-but-wrong-variant listing (wrong
  storage size, wrong bundle, wrong generation) gets rejected outright
  rather than quietly skewing the average. That filter is strict on
  purpose, which means the actual sample count you get is often lower
  than 50 — precision was prioritized over hitting an exact count.
- **Optional eBay login (Config → Search For → "Log into eBay").** eBay
  lookups now use their own persistent browser profile (separate from
  Facebook's), so a one-time login carries over to future lookups instead
  of staying logged out forever. This should help specifically with
  eBay's sign-in-wall failure mode; it's not a guarantee against straight
  bot-detection blocks, which seem more IP/fingerprint-driven than
  session-driven — expect it to still fail sometimes even logged in.
  Entirely optional; logged-out lookups keep working as before if you
  never log in.
- **Active search now drives Facebook's actual "Search Marketplace" box**
  instead of navigating to a constructed URL — clicking into the real
  search input and typing, the same way a person would search by hand.
  Falls back to the URL-based approach automatically if the search box
  can't be found (e.g. after a Facebook redesign), so this degrades
  gracefully rather than breaking active search outright.
- **AI photo analysis (Gemini, optional).** Set a free Gemini API key in
  Config and every deal found in the Feed gets its photos (all of them,
  not just one) sent to Gemini together in one call — it can identify
  individual items in a bundle (e.g. every game visible with a console),
  read visible text/labels/serial numbers, and flag anything the photos
  show that the listing text doesn't mention. This is the one piece of
  the app that actually looks at images — Groq has no vision-capable
  model (checked directly against their live model list), so this
  necessarily uses a separate provider and a separate free key. Entirely
  optional; nothing else in the app depends on it.
- **Database tab.** Add a product name and it builds a knowledge profile:
  an AI-written rundown of variants, identifying details, common bundled
  accessories, and known issues, paired with a real eBay sold-comps lookup
  (price data + reference photos). Important distinction kept visible
  throughout: the AI-written part is the model's own training knowledge,
  not live research — there's no web browsing happening, and it never
  states prices as fact, only the eBay half does that. When a Search For
  item's name matches a Database entry, its profile gets fed into scoring
  automatically to help the AI judge genuine-match/condition calls with
  more context — it's still never a source of pricing truth, same rule as
  everywhere else in this app. "+ Search For" pre-fills the name and eBay
  average as a starting price for you to confirm in Config.
- **All listing photos, not just one thumbnail — but the AI still can't
  see any of them.** Feed cards now show every photo the scraper can find
  on a listing (up to 12), in a scrollable strip, so you can eyeball
  things like a serial-number sticker or a Settings/About screenshot
  without leaving the app or clicking through to Facebook. To be direct
  about the actual capability here: no AI in this app looks at, reads
  text from, or analyzes any photo — there's no vision-capable model
  available on Groq's free tier (checked directly against the current
  model list). This is purely a human-review upgrade. It's also
  best-effort like everything scraped from Facebook's markup — may not
  catch every photo in a listing's gallery, and older listings saved
  before this existed won't have more than their original thumbnail.
- **The scraper reads Facebook's page markup**, which changes without
  notice. `src/main/scraper.ts` is written to be reasonably resilient
  (no dependence on specific CSS class names) but may need adjusting if
  Facebook ships a redesign — see the comment at the top of that file.
- **The eBay "Check eBay" button (Config → Search For) is best-effort
  and often won't return anything.** It's a logged-out lookup of eBay's
  sold-listings search, run in its own throwaway browser (no account,
  no login risk). In testing, eBay blocked plain requests outright and
  sometimes redirected the sold-listings view to a sign-in wall — this
  may work better from your home network than it did in development, but
  there's no guarantee. When it fails you'll see why (blocked / sign-in
  required / nothing parsed) rather than a silently wrong number. It only
  ever suggests a price via a button you click — it never overwrites your
  reference prices on its own.

## Setup

1. **Install dependencies** (also downloads a Chromium build for Playwright):
   ```bash
   npm install
   ```
   On Windows, if PowerShell blocks `npm`/`npx` with a script-execution
   error, use the `.cmd` forms instead: `npm.cmd install`, `npx.cmd ...`.

2. **Run it:**
   ```bash
   npm run dev
   ```
   This opens the app window.

3. **In the app:**
   - Go to **Dashboard** and click **Open Facebook Marketplace** — a real
     browser window opens. Log in if needed, then set your location and
     max distance filter *in that same window* (this is the step that
     fixes the radius not carrying over).
   - Go to **Config**: paste in your Groq API key (free, no card — get
     one at [console.groq.com/keys](https://console.groq.com/keys)), your
     Marketplace browse URL (copy it straight from that same window —
     just the plain location URL, no search term), your Search For items
     with real reference prices, and your ntfy topic. Click **Save
     config**.
   - Back on **Dashboard**, click **Run once** to sanity-check a single
     pass, then **Start continuous scan** to leave it running.
   - Install the [ntfy app](https://ntfy.sh/) on your phone and subscribe
     to the topic you set in Config.

4. **Review results in Feed.** Every evaluated listing shows up there,
   labeled by tier (deal / possible deal / seller risk / skip) — mark
   deals 👍/👎 to build up the feedback the AI uses to calibrate future
   calls.

## Where things are stored

In dev mode, everything lives at the project root (so your existing
`config.json`, `browser-profile/`, and `data/scout.db` still work
unchanged — old configs auto-migrate to the new browse-URL format on
first load): the Facebook browsing session in `browser-profile/`, listing
history + feedback in `data/scout.db`, config in `config.json`, and your
Groq key in `.env`. When packaged as an installed app (`npm run dist`),
these move to the OS's per-user app-data directory instead.

## If scraping breaks

`src/main/scraper.ts` has all the extraction logic. If listings stop
showing up or titles/prices look wrong:

1. Open Marketplace in a normal browser window.
2. Right-click a listing card → Inspect.
3. Compare against the assumptions in `browseListings()` (it reads each
   listing link's `aria-label`, falling back to visible text, and looks
   for a `$`-prefixed price and an image `src`) or `extractSellerSignals()`
   for the seller-info regex patterns.
4. Adjust the parsing there — nothing else in the app needs to change.

## Scripts

- `npm run dev` — run the app in development
- `npm run build` — build main/preload/renderer bundles
- `npm run typecheck` — typecheck main+preload and renderer separately
- `npm run pack` — build an unpacked Windows app (for testing)
- `npm run dist` — build an installable Windows app

## Clynx Cloud

`cloud/` is a separate, standalone backend project — its own
`package.json`/`tsconfig.json`, never bundled into the desktop build. It
provides auth/devices, Watch cloud sync, listing ingestion + dedup, and an
async job queue, all opt-in behind `Config.cloud.enabled` (default `false`)
so the desktop app works exactly as it always has when cloud is off or
unreachable. See [`cloud/README.md`](cloud/README.md) for setup.
