# Clynx deal-qualification audit (read-only; no code was changed)

Scope: how a listing becomes a "deal" (Feed "Deals", Dashboard Best Deals, ntfy alert), across every pathway, and why weak, stale, or low-margin listings can get through. Everything below was traced in the current code. Line numbers are as of 2026-10-11.

Evidence used besides code: a read-only copy of one account's `scout.db` (22 listings; small, and it predates a few recent fixes, so treat it as illustrative, not statistical).

---

## 1. Verdict in one paragraph

The deterministic profit math (84% net, 20% minimum margin, 15% negotiation cap) is sound **where it is applied**, but it is applied in only some pathways, and the **age filter fails open** for the most common Facebook phrasings. Five of the six ways a listing becomes a deal either skip the margin rule entirely (AI-judged tiers, Watches, hidden-gem photo estimates) or accept thin evidence (one or two sales, ask-only prices, stale comps). There is also **no final gate**: `isDeal` is decided once, never revoked, and every screen reads it raw, so a deal whose alert was withheld still shows as a deal in the Feed. The "worth a look" idea exists only as a yellow outline derived in the UI, not as a tier in the data.

---

## 2. Pathway map: every way a listing reaches the Feed or a notification

| # | Pathway | Entry (file : function) | Scored by | Can alert? | Alert gate |
|---|---|---|---|---|---|
| A | **Search** (matches a Search For item) | `scrapeEngine.ts : evaluateListing` → `scorer.ts : scoreListing` (search branch) | deterministic `evaluateSearchItemPricing`, **or AI** when the item has no reference value (A2) | yes | `preAlert.prepareAlert` (`canWithhold: true`) |
| B | **Database title** (title names a Database product with an eBay value) | same → `scoreListing` (`valueForTitle` branch, scorer.ts:767) | deterministic `evaluateSearchItemPricing` | yes (tier labelled "search") | same |
| C | **General AI** (no match, no Database value) | same → `extractGeneralDeal` (scorer.ts:505, 803) | **AI only**, tier "general" | yes | same |
| D | **Facebook Watch, passive** (scanner stumbles on a Watch product) | `evaluateListing` → `recordWatchMatchesIfAny` (scrapeEngine.ts:1063), called before and after vision | Watch's own conditions (`watchMatching.evaluateWatchConditions`) | yes | `canWithhold: false` |
| E | **Facebook Watch, active** (scheduler) | `runWatchCheck` → `evaluateWatchCandidate` (scrapeEngine.ts:3294) → `scoreListing` → `recordWatchMatchesIfAny` | Watch conditions | yes | `canWithhold: false` |
| F | **eBay (Search / Database / General)** | `ebayEngine.ts` (loop ~295-399) → `scoreListing` | same three scorers | yes | `canWithhold: true` |
| G | **eBay Watch** | `ebayEngine.ts : recordWatchMatches` (406) | Watch conditions | yes | `canWithhold: false` |
| H | **Post-score promotions inside D/A/B/C**: green-flag promotion (scrapeEngine.ts ~1966), hidden gem / bundle (~2077-2150) | `evaluateSearchItemPricing`, `repriceWithExtras` | can flip `isDeal` to true | via A-C's alert block (2350) | same |

All listings, deal or not, are saved (`store.saveScored`) and appear in the Feed's "All" view (by explicit earlier request). "Deals" = `isDeal` (Feed.tsx:62-63). Best Deals and the Dashboard counters also read raw `isDeal` (Dashboard.tsx:71, 219).

### Matrix: which rules each pathway actually enforces

| Rule | A Search (priced) | A2 Search (no ref value) | B Database | C General AI | D/E FB Watch | F eBay | G eBay Watch |
|---|---|---|---|---|---|---|---|
| Min margin after fees (20%) | **yes** (`profitable`), or via budget+reach | **no** (AI opinion) | yes | **no** | **no** (only the Watch's own min profit $/discount %, if set) | as A/B/C | no |
| Negotiation cap (15%) | yes, as `reachable` | no | not needed (margin rule is stricter) | no | no | alert-time only | no |
| Max listing age (global) | yes, **but fails open** (F1, F2) | same | same | same | **D: yes (rescue leak F3); E: no** | yes (reliable timestamp) | yes (the global gate runs before Watch matching) |
| Needs real resale comps | uses Database value if any, else the item's typed reference | none | requires a Database value, no quality check | **none** | reference price optional; falls back to Facebook asking average (F9) | as A-C | same as watch |
| Final alert gate | reach-only (F8) | reach-only, usually `null` → passes | reach-only | reach-only, usually `null` → passes | **none** (placeholder price only) | reach-only | none |

---

## 3. Findings (each with file, function, exact path, fix)

Severity key: **Critical** = directly produces the reported symptom; **High** = lets weak deals through; **Medium** = misleading or weakens recall/precision; **Low** = note.

### F1 (Critical): the age filter fails open for Facebook's most common phrases
- **Where**: `listingAge.ts : estimateListingAgeHours` (14-33) and `isListingTooOld` (46-54); text comes from `scraper.ts : extractListingAge` (1272).
- **Path**: Facebook detail page → `extractListingAge` captures the text after "Listed" verbatim → `evaluateListing` (scrapeEngine.ts:1572-1577) → `isListingTooOld`.
- **Defect**: the parser only accepts a **digit** followed by a unit (`^(\d+)\s*(minute|...)`). Facebook also writes **"a day ago", "a week ago", "a month ago", "about an hour ago"**. These return `null`, and `isListingTooOld` returns `false` when the age is `null` ("can't tell, don't skip", listingAge.ts:7-13, 48-53).
- **Evidence (real data)**: of 22 listings, **8 had an unparseable age** ("a day ago" ×4, "a week ago" ×3, "about an hour ago" ×1); **4 of those 8 are saved as deals**, including an Xbox Series S "**a week ago**" (7 days old) with `is_deal = 1`. With a 24-hour window, "a day ago" (24h) and "a week ago" (168h) should both be rejected. The "months old" listings are the same bug: "a month ago" and "2 months ago" variants.
- **Fix**: parse `a / an / one / about / over / almost / more than` + unit; treat unrecognized text as **unknown, not fresh** (see F2).

### F2 (High): a missing age is treated as fresh
- **Where**: `isListingTooOld` returns `false` when `ageText` is null; `extractListingAge` returns null when no "Listed ... ago" is in the page text. **Evidence**: 2 of 22 listings have no age at all, 1 of them a (general-tier) deal.
- **Impact**: a stale listing, or one whose layout changed, is scored like a fresh one.
- **Fix**: a three-state result (`fresh | stale | unknown`). Unknown must not qualify as a **deal** (it may still be shown as "worth a look", see section 5). Also persist the parsed hours (`listing_age_hours`) and the parse source.

### F3 (High): the Facebook Watch paths do not enforce the global age cap, and a Watch can rescue an old listing into normal deal scoring
- **Where (E)**: `evaluateWatchCandidate` (scrapeEngine.ts:3294-3340) never calls `isListingTooOld`. The only age control is Facebook's own "Date listed" filter, which `searchMarketplace` applies best-effort (scraper.ts:278, and `runWatchCheck` passes `watch.maxListingAgeMinutes` or the global value, scrapeEngine.ts:3213). If the control can't be clicked it logs and continues unfiltered.
- **Where (D)**: `evaluateListing` lines 1573-1577: a price-qualified Watch whose `maxListingAgeMinutes` is `null` (no age condition) "rescues" a too-old listing from the global gate. **The listing then continues through the standard scoring path** (A/B/C), where nothing re-checks age, so it can become an ordinary, alerted "deal". The code comment itself acknowledges that nothing downstream re-checks freshness.
- **Evidence**: an Xbox Series X "**4 days ago**" is saved with `is_deal = 1` under a config whose cap is 24 hours (no watches exist in this copy, so I cannot prove which path; both D and E produce exactly this, and no other path skips the gate).
- **Fix**: keep the Watch's own rules for the Watch match, but run the **universal gate** (section 5) on every listing before it is allowed to be a *deal* or a general alert; a Watch rescue must only let the listing be evaluated *as a Watch match*, not as a standard deal.

### F4 (Medium): which timestamp is used
- The gate uses **Facebook's relative "Listed X ago" text, captured at scrape time** (see answer 3 below). It is not an original posting date, is imprecise ("3 weeks"), and the app does not know whether Facebook resets it when a seller renews/edits/reposts. Re-scans never recompute it. The Feed card shows the stored string forever (`ListingCard.tsx:326`), so a card read days later still says "2 hours ago" (`firstSeenAt` exists but is not used to anchor it).
- **Fix**: store `observed_at` + parsed `age_hours`; display "listed ~N h before we saw it"; for eBay (reliable ISO timestamp, `ebayNormalize.ts : formatListingAge`) store the exact date.

### F5 (High): a Search item with no reference value becomes a "search-tier" deal on the AI's say-so
- **Where**: `scorer.ts : scoreListing`, search branch, lines 672-699. `typicalResaleUsd <= 0` and no Database value → `extractGeneralDeal` → `isDeal = isPotentialDeal && confidenceOk`, `dealTier: "search"`.
- **Defects**: no profit math, no margin, no negotiation; the model's own `estimatedValueRangeUsd` is the only "value"; it is labelled with the trusted **search** tier (log says "DEAL", not "POSSIBLE DEAL"), ntfy priority "high" for search tier (`notify.ts : sendDealAlert`), and it ignores `generalDeal.enabled`.
- **Fix**: this branch must never output tier "deal"; downgrade to "worth a look" until a real value exists (and trigger Database research for that item so the next listing is priced deterministically).

### F6 (High): General-tier AI deals have no margin rule and can be alerted with no sales data
- **Where**: `scorer.ts` lines 803-827 (`extractGeneralDeal`, minimum confidence "medium" by default) then `scrapeEngine.ts:2350` → `prepareAlert`.
- **Path**: `prepareAlert` (preAlert.ts:28-74) runs the market check; with no sales data `rateDeal` returns a neutral 3 stars and `reachable: null` (dealSummary.ts:77-93), and the withhold test is `reachable === false` (preAlert.ts:69), so `null` passes. Result: an unverified AI deal is pushed with "No sales data yet to judge the price".
- **Evidence**: two of the sample's general-tier "deals" are model valuations only (e.g. "typically resells ... $260-360", "$180-300"), with no deterministic check behind either.
- **Fix**: general-tier needs deterministic confirmation (market check returned a real value that clears margin) to be a deal; otherwise "worth a look", no push.

### F7 (High): weak or missing resale comparisons are accepted at full confidence
- **Where**: `store.ts : EBAY_VALUE_SQL` (line 14) = `COALESCE(ebay_est_value_usd, ebay_avg_sold + ebay_avg_shipping)`; used by `getEbayValueForProductName` (822), `getEbayValueForTitle` (891), `getProductSignals` (860).
- **Defects**: no minimum sample size (1-2 sales is accepted), no check of the estimate's **basis** (`active` = asking prices only is accepted as value), no **age** check on `ebay_comps_checked_at` (stale comps used indefinitely at scoring time; the 3-day refresh exists only in the pre-alert market check), fuzzy name/title matching (`isSimilarProductName`, `compMatchesSpecs`) with no match-confidence output. `scoreListing` then treats the number as certain; `confidence` is hard-coded `"high"` for search and Database branches (scorer.ts:633, 789).
- **Fix**: return an **evidence object** `{valueUsd, basis, sampleSize, ageDays, matchQuality}` instead of a bare number; the gate decides tier from it (section 5).

### F8 (High): the alert gate re-checks only "reachable by negotiation", not margin, stars, or evidence
- **Where**: `preAlert.ts : prepareAlert` line 68-69: `skip = canWithhold && summary.reachable === false`.
- **Defects**: (1) a listing that is within 15% negotiation reach but **loses money or is thin at asking price** is alerted; stars are not a gate (a 1-star "deal" is pushed); (2) `reachable` is `null` without data and passes (F6); (3) the check uses the **fresh** market value, but `isDeal` was set from the **older** value and is never revisited (F11); (4) Watch matches use `canWithhold: false`, so no check at all.
- **Fix**: the universal gate (section 5) replaces this test; `prepareAlert` becomes a thin caller.

### F9 (High): Watch matches ignore the user's margin and negotiation settings; the Watch "reference price" can be a Facebook asking average
- **Where**: `watchMatching.ts : evaluateWatchConditions` (133-162) and `deriveWatchReferencePrice` (99-111).
- **Defects**: a Watch with no profit/discount/age conditions is `satisfied: true` for **any** title-matching, price-qualified listing; where a minimum profit is set, `profitUsd = reference × net% − price` ignores condition, shipping (Facebook), the user's **minimum margin %**, and the negotiation cap. `deriveWatchReferencePrice` falls back (after eBay value and the user's resale price) to `store.getFacebookPriceStats` (**the average asking price of other Facebook listings of that product**), which is not a resale value, so "profit" can be computed against other sellers' hopes. Alerts go out with `canWithhold: false`.
- **Fix**: keep Watch's purpose (it is allowed to be looser) but make the **tier explicit**: a Watch match is delivered as "Watch match", with the gate's verdict attached (stars, evidence, margin, age), and never counted as a "Deal" in Feed/Best Deals unless it also passes the gate. Do not let a Facebook-average reference produce a profit number (label it "vs. other listings").

### F10 (High): hidden-gem / bundle value can turn a weak listing into a deal
- **Where**: `scrapeEngine.ts : runPostScoringPipeline`: hidden gem trigger (1884), vision lump fallback (2106), `repriceWithExtras` (2121), `profitGate.ts : repriceWithExtras / isHiddenGemCandidate`.
- **Defects**: the **vision-based lump estimate** (`photoResult.bundleEstimatedValueUsd`, a single model guess of "typical resale of the extras") is used whenever vision says there is a valuable bundle. It is **not** limited by `isHiddenGemCandidate`'s "price within 1.6× base value" test (that test only decides whether vision runs in low-AI mode), has **no cap** relative to the base item, and needs no corroboration from the listing text. If the lot then clears margin, `isDeal` flips to true with tier "search" (2136-2145). The new item-by-item bundle breakdown is capped (extras lift ≤ ~30% of the focal item) and is only a deal-maker when the lot clears the margin; its AI `guessUsd` stand-ins are flagged as estimates but still count.
- **Preserve**: genuine hidden gems (the console-with-games case).
- **Fix**: keep the path, but (a) cap the vision lump at a fraction of the base value (for example ≤ 40%), (b) require the extras to be corroborated (named in the text, or vision confidence high), (c) require the *base* evidence to be solid (F7), (d) tier it "deal" only if the lot clears margin **using only counted, priced, non-estimated extras**; otherwise "worth a look: possible hidden gem".

### F11 (Medium-High): `isDeal` is never revoked; Feed and Dashboard show withheld deals as deals
- **Where**: `scrapeEngine.ts:2350-2372` and `ebayEngine.ts:361-382`: `prepareAlert` may decide not to send, but nothing writes that back; `saveScored` stored `is_deal = 1` earlier. Feed "Deals" (Feed.tsx:62), Best Deals (Dashboard.tsx:219), "deals today" (Dashboard.tsx:71), `isHotListing`, and the "flash-deal" card style all read raw `isDeal`.
- **Effect**: the Feed contradicts the notifications ("Skipped the alert ... would need negotiating 22%" yet the card shows a deal). The deal narration also fires for withheld deals.
- **Fix**: persist the gate's verdict (`deal_status`, `gate_reasons`, `gate_stars`) and have every screen read that.

### F12 (Medium): "worth a look" is a UI outline, not a data tier
- **Where**: `ListingSourceMarks.tsx : listingVerdict` (54-71): deal with confidence ≠ high → "unsure" (yellow); non-deal with discount ≤ 0 → "pass" (red); **everything else, including non-deals with a small positive discount, shows as "interested"** (normal source color). `greenFlag` is only a log level (Activity). The `ScoredListing.dealTier` field has only `"search" | "general" | null`.
- **Answer to your question 6**: weak listings are **not** intentionally shown as "worth a look": they are classified `isDeal = true` (tier "search" for A2/B, "general" for C) and merely outlined yellow when confidence is medium; Search/Database deals are always "high" confidence (hard-coded), so they never get the yellow outline however thin the evidence.
- **Fix**: add a real `deal_status`: `deal | worth_a_look | pass`.

### F13 (Low-Medium): vision and photo checks can only demote, and they fail open
- Mismatch override (scrapeEngine.ts:2035) runs only when `matchedItem` is set and `matchesClaim === false`; a failed/unavailable vision call yields no veto (`!== false` passes), and general-tier deals (no claimed item) are never photo-checked. In low-AI mode vision is skipped for non-deals but runs for deals, so deals do get a check when photos exist (`photoAnalysis.enabled` and images present).
- AI/vision/hidden-gem/bundle/Watch **cannot override** the deterministic **early** rejections (blacklist, placeholder price, non-round price, unshippable, seller risk, scam bot, hard price cap, official-shipping/eBay mention) because those `return` before scoring (age is the exception, F1-F3). The hard price cap is applied after all promotions (scrapeEngine.ts:2184).

### F14 (Low): the margin rule is implemented as "reachable by haggling" in the budget path
- `evaluateSearchItemPricing` (scorer.ts:413): `isDeal = (withinBudget && reachable) || profitable`. A listing under the user's max price that needs up to the negotiation cap off asking counts, even though the margin **at the asking price** is below the minimum. This is by design but it is the main reason "poor margin" deals appear, and the Feed does not say "needs 14% off".
- **Fix**: show "needs N% off" in the card, and make it a gate option (strict: margin must hold at asking).

### F15 (Info, recall): existing filters that cost recall (intentional)
- `isNonRoundPrice` (`price % 5 !== 0`, scrapeEngine.ts:74) skips everything not ending in 0 or 5 ($149, $199) before any scoring. Applies to Facebook search listings only (not Watch prefilter, not eBay). The universal gate should not duplicate or compound it.

---

## 4. Direct answers to your eight questions

1. **Every pathway into the Feed/notification**: see the table in section 2 (A-H). All saved listings reach "Feed: All"; the "Deals" set and every alert come from A-G.
2. **Do all pathways enforce margin / age / negotiation?** No. Margin: enforced in A (priced), B, F-priced and the hidden-gem lot check; **not** in A2, C, D, E, G (and not as an independent test at alert time). Age: enforced for A-D and F except the fail-open cases (F1, F2) and the Watch rescue (F3); **not** enforced in E. Negotiation cap: only as part of A's `reachable` and the pre-alert test; not for C-null/Watches.
3. **What timestamp does the age filter use?** Facebook's **relative "Listed X ago" text scraped from the detail page at scrape time**, converted to hours by `estimateListingAgeHours`; it is an unreliable parsed timestamp, not an original posting date, and **not** last-updated or first-seen time (`first_seen_at` is stored but unused for gating). Unparsed or absent text means "don't skip" (F1, F2). eBay uses a real ISO `itemCreationDate`, reformatted to the same text (reliable, but then re-parsed, fine).
4. **Can AI / vision / hidden gem / bundle / Watch override a deterministic rejection?** Not the early cheap rejections or the hard price cap. They **can create a deal** where the deterministic rule never ran or ran only on the base item: AI tiers (F5, F6), hidden-gem vision lump (F10), Watch rescue past the age gate (F3), Watch matches bypassing margin (F9).
5. **Weak/missing comps still confident?** Yes (F7, F6, F5): thin samples, ask-only, stale comps and fuzzy matches are scored as "high" confidence; with no data the alert is still sent at a neutral 3 stars.
6. **Feed visibility vs qualification?** Feed shows everything by design; but "deal" is not separated from "worth a look" in the data, and weak listings are classified as deals (F11, F12).
7. **Universal gate**: section 5.
8. **Preserving hidden gems / undervalued products**: see section 5 "Recall protections".

---

## 5. Recommended: one universal Deal Quality Gate

### 5.1 Shape
A single **pure function** (new file, for example `dealGate.ts`) with no I/O, called from every path that can mark a listing a deal or send an alert:

```
qualifyListing(input) → {
  status: "deal" | "worth_a_look" | "pass",
  stars: 1-5 | null,
  reasons: [{code, severity, text}],     // why it passed / what held it back
  facts: { valueUsd, basis, sampleSize, compAgeDays, matchQuality,
           ageHours, ageState: "fresh"|"stale"|"unknown",
           profitAtAskUsd, marginAtAskPct, cutNeededPct, extrasUsd, extrasEstimated }
}
```
Inputs: the scored listing, a **ValueEvidence** object (from F7's fix), parsed age, settings (net %, min margin, max cut, max age), pathway (`search | database | general | watch | ebay`), the Watch (if any), and vision flags (`matchesClaim`, bundle details).

### 5.2 Call sites (every producer goes through it)
1. `scrapeEngine.ts : runPostScoringPipeline`, after the last `isDeal`-affecting block (after hard cap, 2209) and before the alert (2350). It sets `isDeal` from `status === "deal"` and persists `deal_status`.
2. `scrapeEngine.ts : evaluateWatchCandidate` and `recordWatchMatchesIfAny` (before `prepareAlert`).
3. `ebayEngine.ts` main loop and `recordWatchMatches`.
4. `preAlert.ts : prepareAlert` uses the gate's result (including the fresh market value) instead of `summary.reachable === false`; if the fresh value demotes the listing, **write the demotion back** (fixes F11).

### 5.3 Rules (all deterministic; thresholds configurable, defaults suggested)
| Check | Fails to | Default |
|---|---|---|
| Placeholder / $0 price | pass | existing rule |
| Age state **stale** (≥ max age) | pass | existing 24h, now with a robust parser |
| Age state **unknown** | worth_a_look (never "deal") | new |
| No ValueEvidence | worth_a_look (shown, no push) | new (fixes F5, F6) |
| Evidence weak: sample < 3, or basis = active-only, or comps older than 14 days (refresh first, then re-evaluate), or match quality low | worth_a_look | new |
| Margin at asking price < min margin **and** cut needed > max cut | pass | existing rule |
| Margin at asking < min margin but cut needed ≤ max cut | deal only if evidence strong; else worth_a_look; the card says "needs N% off" | existing intent, made visible |
| Extras: counted only if corroborated, capped, not estimated | otherwise ignored in margin | new (fixes F10) |
| Stars < 3 | worth_a_look, no push | new |
| Vision: mismatch confirmed | pass; vision **unavailable** → cannot upgrade a thin-evidence listing | existing + new |
| Watch match | status stays "Watch match"; delivered as today, with the gate's stars/evidence/age attached; counts as a "deal" in Feed/Best Deals only if it also passes | new |

### 5.4 Data and UI changes (when approved)
- New columns: `deal_status`, `gate_reasons` (JSON), `gate_stars`, `listing_age_hours`, `value_basis`, `value_sample`. Feed "Deals" = `deal_status = deal`; a new "Worth a look" filter; Best Deals and counters read `deal_status`. ntfy: push only `deal` (and Watch matches); optional low-priority silent push for `worth_a_look` behind a setting.
- Cards show the reason in plain words ("Needs 12% off asking", "Only 2 sales to go on", "Age unknown").

### 5.5 Recall protections (so hidden gems and real bargains are not lost)
- "Worth a look" is a **visible, not discarded** state; borderline and thin-evidence listings stay in the Feed (this is where recall is preserved while precision rises).
- Hidden gems keep their own path, but must name the extras in the listing or vision (high confidence), with capped, priced, non-estimated extras; otherwise they appear as "Worth a look: possible hidden gem".
- Unknown-age listings and AI-judged finds are not thrown away; they are demoted, and AI-judged finds **trigger Database research for that product** so the next one is priced deterministically (this converts General discoveries into verified deals over time).
- A Watch keeps delivering what it was built for.
- A user setting `Strict quality gate` (default on) lets power users loosen the evidence rules (for example allow a 2-sale value as a deal).

### 5.6 Tests to write before shipping (golden cases)
Age phrases (a day / a week / a month / about an hour / 4 days / missing / "yesterday"), Watch rescue, AI-only deals with and without market data, 1-sale and ask-only value, stale comps, hidden gem with and without corroborated extras, margin-at-ask vs reachable, alert-time demotion write-back, Watch match labelling.

---

## 6. Suggested order of work (after you review)

1. **F1/F2** (parser + three-state age): small, isolated, directly fixes the "months old" symptom.
2. **F3** (age gate for Watch paths and no rescue into standard deals): small.
3. **F7** (ValueEvidence) then the **gate** (`dealGate.ts`) and its persistence (F5, F6, F8, F11, F12, F14).
4. **F10** (hidden-gem caps and corroboration), **F9** (Watch labelling).
5. UI: "Worth a look" filter, card reasons, Best Deals source.

## 7. Decisions I need from you

1. Unknown age: may it ever count as a **deal** (I recommend no: "worth a look")?
2. Should a **Watch match** also have to pass the gate to count as a "Deal" in Feed/Best Deals (I recommend yes for the label, no for delivery)?
3. May an **AI-only** (General) find ever be pushed to the phone? (Recommend: only after the market check confirms margin.)
4. Minimum evidence for a "deal": 3 sales? Allow ask-only value if ≥ 8 asks? Maximum comp age 14 days?
5. Should "needs N% off" listings (margin below minimum at asking, within the 15% cap) stay deals, or become "worth a look"?
6. Do you want "worth a look" pushed silently (low priority) or Feed-only?

*No code was modified for this audit.*
