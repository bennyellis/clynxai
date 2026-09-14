import type { Page } from "playwright";
import { OPENAI_MODEL, OPENAI_URL, getOpenAIApiKey } from "./openai.js";
import { changeLocation } from "./scraper.js";

const OPENAI_TIMEOUT_MS = 30_000;

// Per explicit instruction — "State" mode used to have the AI list 10
// major cities and resolve each one to its own real Facebook location
// (10 separate "Change location" dialog drives, each a real navigation +
// several waits) before a scan could even start. That's genuinely slow for
// what it bought: one single, well-chosen city with a wide-enough radius
// covers a state just as well for browsing purposes. This asks for exactly
// ONE — the state's most populous/well-known city, the one anyone from
// there would name first — formatted as "City, State" using the state's
// FULL name (e.g. "Phoenix, Arizona", not "Phoenix, AZ") — confirmed live
// against a screenshot of Facebook's own Location field, which persists
// the full name, never a 2-letter abbreviation.
export async function lookupPrimaryCityInState(state: string): Promise<string> {
  const prompt = `What is the single most populous/major city in the US state of "${state}" — the one anyone from that state would name first? Respond with ONLY a JSON object, no other text, in this exact shape:
{ "city": string }
Formatted as "City, ${state}" using the state's full name spelled out (not a 2-letter abbreviation — that's what actually has to be typed into Facebook Marketplace's own location search box).`;

  const apiKey = getOpenAIApiKey();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_completion_tokens: 200,
        // gpt-5-mini is a reasoning model — silently burns the whole
        // completion-token budget on invisible reasoning tokens without
        // this, same lesson as everywhere else this app calls OpenAI.
        reasoning_effort: "minimal",
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content ?? "";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
    const city = typeof parsed.city === "string" ? parsed.city.trim() : "";
    if (!city) throw new Error("The AI didn't return a city.");
    return city;
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
      return { city, url: null, resolvedState: null, error: result.error };
    }
    // "Richmond, Virginia" -> "Virginia" — whatever sits after the last
    // comma in Facebook's own confirmed "City, State" label.
    const resolvedState = result.resolvedLocationLabel?.split(",").pop()?.trim() ?? null;

    const currentUrl = page.url();
    if (!/\/marketplace\/[a-zA-Z0-9]+/.test(currentUrl)) {
      return { city, url: null, resolvedState, error: `Landed on an unexpected URL: ${currentUrl}` };
    }

    const parsed = new URL(currentUrl);
    parsed.pathname = parsed.pathname.replace(/\/search\/?$/, "");
    parsed.search = "";
    return { city, url: parsed.toString(), resolvedState, error: null };
  } catch (err) {
    return { city, url: null, resolvedState: null, error: (err as Error).message };
  }
}

export async function discoverLocations(
  page: Page,
  cities: string[],
  onResult?: (result: LocationDiscoveryResult) => void,
  targetRadiusMiles?: number
): Promise<LocationDiscoveryResult[]> {
  const results: LocationDiscoveryResult[] = [];
  for (const city of cities) {
    const result = await discoverLocation(page, city, targetRadiusMiles);
    results.push(result);
    onResult?.(result);
  }
  return results;
}

