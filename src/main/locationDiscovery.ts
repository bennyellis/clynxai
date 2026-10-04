import type { Page } from "playwright";
import { OPENAI_MODEL, callOpenAI } from "./openai.js";
import { changeLocation } from "./scraper.js";
import { politeDelay } from "./browser.js";

const OPENAI_TIMEOUT_MS = 30_000;

// Per explicit instruction — "make sure when in a state... the search
// algorithm follows the same path [as country mode]... it rotates the top
// 10 cities." This used to resolve just ONE city per state (a deliberate
// simplification made when resolution was eager — done synchronously the
// moment Config was edited, so 10 separate "Change location" dialog drives
// before a scan could even start was genuinely slow). Location resolution
// is lazy now (see index.ts's resolveAccountLocationIfNeeded — it only
// happens once, the next time the account actually starts, not on every
// Config edit), and a single-city state has no fallback if that one city
// happens to be flaky (verified live: a Michigan account stuck retrying a
// single timed-out "detroit" browse, cycle after cycle, with nowhere else
// to go) — resolving the state's top cities instead gives runCycle's
// existing random-pick-and-rotate logic the same real redundancy country
// mode already has. Each formatted as "City, State" using the state's FULL
// name (e.g. "Phoenix, Arizona", not "Phoenix, AZ") — confirmed live
// against a screenshot of Facebook's own Location field, which persists
// the full name, never a 2-letter abbreviation.
export async function lookupTopCitiesInState(state: string, count = 10): Promise<string[]> {
  const prompt = `List the ${count} most populous/major cities in the US state of "${state}" — real, well-known cities Facebook Marketplace would recognize as browsable locations, the ones anyone from that state would readily name. Respond with ONLY a JSON object, no other text, in this exact shape:
{ "cities": string[] }
Each entry formatted as "City, ${state}" using the state's full name spelled out (not a 2-letter abbreviation — that's what actually has to be typed into Facebook Marketplace's own location search box). Exactly ${count} entries, unless the state genuinely doesn't have that many notable cities.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const res = await callOpenAI(
      "chat",
      {
        model: OPENAI_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_completion_tokens: 600,
        // gpt-5-mini is a reasoning model — silently burns the whole
        // completion-token budget on invisible reasoning tokens without
        // this, same lesson as everywhere else this app calls OpenAI.
        reasoning_effort: "minimal",
      },
      controller.signal
    );
    if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content ?? "";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
    const cities = Array.isArray(parsed.cities)
      ? parsed.cities.map((c: unknown) => String(c).trim()).filter(Boolean)
      : [];
    if (!cities.length) throw new Error("The AI didn't return any cities.");
    return cities;
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`OpenAI request timed out after ${OPENAI_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export interface LocationDiscoveryResult {
  city: string;
  url: string | null;
  // The state this resolved to, per Facebook's OWN confirmation (the
  // sidebar's "City, State · Within N mi" label after Apply) — not just
  // echoed back from whatever was typed in, since a ZIP code query has no
  // state in the input at all. See scrapeEngine.ts's listingStateMatches,
  // the actual consumer of this.
  resolvedState: string | null;
  // The FULL "City, State" label Facebook itself confirmed (resolvedState
  // above is just the tail end of this) — added for Watch's own
  // resolved_location_label cache (see scrapeEngine.ts's runWatchCheck), no
  // existing caller reads this so it's purely additive.
  resolvedLocationLabel: string | null;
  error: string | null;
}

// Drives Facebook's own "Change location" dialog to resolve a city name to
// a real Marketplace location URL, rather than guessing/fabricating a
// location ID ourselves — the same principle as everywhere else in this
// app. Confirmed live via a screenshot the user shared: the exact same
// dialog scraper.ts's verifyOrSetRadius already drives for the radius
// check, its own "Location" field holding a full "City, State" value (see
// scraper.ts's changeLocation for the field/dialog-finding details, kept
// there since it's the same dialog either caller opens).
//
// Conservative on purpose: if it can't confirm an option actually
// matches the city you asked for, it reports failure rather than
// guessing and clicking something that might be wrong.
export async function discoverLocation(page: Page, city: string, targetRadiusMiles?: number): Promise<LocationDiscoveryResult> {
  try {
    await page.goto("https://www.facebook.com/marketplace/", { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(1500);

    const result = await changeLocation(page, city, targetRadiusMiles);
    if (!result.ok) {
      return { city, url: null, resolvedState: null, resolvedLocationLabel: null, error: result.error };
    }
    // "Richmond, Virginia" -> "Virginia" — whatever sits after the last
    // comma in Facebook's own confirmed "City, State" label.
    const resolvedState = result.resolvedLocationLabel?.split(",").pop()?.trim() ?? null;

    const currentUrl = page.url();
    if (!/\/marketplace\/[a-zA-Z0-9]+/.test(currentUrl)) {
      return { city, url: null, resolvedState, resolvedLocationLabel: result.resolvedLocationLabel, error: `Landed on an unexpected URL: ${currentUrl}` };
    }

    const parsed = new URL(currentUrl);
    parsed.pathname = parsed.pathname.replace(/\/search\/?$/, "");
    parsed.search = "";
    return { city, url: parsed.toString(), resolvedState, resolvedLocationLabel: result.resolvedLocationLabel, error: null };
  } catch (err) {
    return { city, url: null, resolvedState: null, resolvedLocationLabel: null, error: (err as Error).message };
  }
}

export async function discoverLocations(
  page: Page,
  cities: string[],
  onResult?: (result: LocationDiscoveryResult) => void,
  targetRadiusMiles?: number
): Promise<LocationDiscoveryResult[]> {
  const results: LocationDiscoveryResult[] = [];
  for (let i = 0; i < cities.length; i++) {
    // Root-caused live: country mode's new 48-city resolution (see
    // config.ts's DEFAULT_COUNTRY_CITIES) was landing only ~2 of 48 for
    // several real accounts — every account's OWN first city resolved
    // fine, then nearly everything after it failed. State mode never hit
    // this because it only ever drives 10 of these back-to-back; changing
    // a real account's location 48 TIMES in a row with no pause between
    // them reads exactly like the kind of rapid-fire action Facebook's own
    // anti-abuse throttling is built to catch — it likely started quietly
    // failing/blocking the dialog well before city #3. A real, jittered
    // pause between each city (same politeDelay this app already uses
    // elsewhere for exactly this reason) gives Facebook's own throttling
    // nothing suspicious to react to. Skipped before the very FIRST city
    // (nothing to space out from yet).
    if (i > 0) await politeDelay(2500, 5000);
    const result = await discoverLocation(page, cities[i], targetRadiusMiles);
    results.push(result);
    onResult?.(result);
  }
  return results;
}

