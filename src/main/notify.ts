import type { Config, ScoredListing } from "./types.js";

// HTTP header values are restricted to Latin-1 (fetch enforces this and
// throws otherwise), but listing titles/our own formatting can contain
// arbitrary Unicode (em dashes, curly quotes, emoji from the listing
// text). ntfy supports RFC 2047 encoded-word headers for exactly this
// case, so anything non-ASCII gets base64-wrapped instead of sent raw.
function encodeHeader(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

// Verified live miss, reported as "it finds one exact match then stops
// searching immediately after": this fetch had no timeout, unlike every
// other network call in this app (see vision.ts's fetchWithTimeout,
// openai.ts's own timeouts, webResearch.ts's downloads). evaluateListing
// awaits this directly inside the per-listing loop (see scrapeEngine.ts) —
// a real network error was already caught by that call's try/catch and
// just logged, but a hang (ntfy.sh slow to respond, a flaky connection that
// never resolves either way) isn't an error at all, so nothing there could
// catch it; the loop would just sit frozen on that one listing forever
// instead of moving on to evaluate the rest of the search results. A
// notification is not worth blocking the whole scan over, so this fails
// fast instead.
const NTFY_TIMEOUT_MS = 10_000;

export async function sendDealAlert(config: Config, scored: ScoredListing): Promise<void> {
  const { listing, extraction, dealTier } = scored;

  const isSearchMatch = dealTier === "search";
  // Per explicit instruction — "make the ntfy notifications very simple:
  // [listed product] * {price} * {age}." Replaces the old multi-line
  // title/body (reference price, discount %, notes, full AI reasoning) —
  // that detail is still one tap away in the app itself (Click still opens
  // the real listing), this is just the glanceable push. matchedItem is
  // the clean tracked-item name for a search-tier deal; a general
  // (unverified) deal has no matchedItem, so it falls back to the
  // listing's own raw title.
  const productName = extraction.matchedItem ?? listing.title;
  const summaryLine = `${productName} * $${listing.price} * ${listing.listingAge ?? "age unknown"}`;

  const url = `${config.ntfy.server.replace(/\/$/, "")}/${config.ntfy.topic}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NTFY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      body: summaryLine,
      headers: {
        Title: encodeHeader(summaryLine),
        Click: encodeHeader(listing.url),
        Priority: isSearchMatch ? "high" : "default",
        Tags: isSearchMatch ? "moneybag" : "thinking",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      // Verified live: posting to this exact ntfy.sh topic via a plain curl
      // succeeds (200 OK, message delivered) — so a failure here is
      // something about THIS request specifically (bad/expired topic,
      // rate-limiting, a malformed header), not the service being down.
      // Reported live as "ntfy pushes are failing" with nothing to show for
      // it in the app itself: this used to only console.error, which goes
      // to a terminal the user isn't necessarily watching, and the caller
      // (scrapeEngine.ts) marks the listing notified unconditionally right
      // after this returns — so a failed push used to be silently swallowed
      // AND the listing would never be retried. Throwing here instead
      // routes it through the SAME try/catch the caller already has for a
      // hard network error, which logs "Notification failed: ..." to
      // Activity and skips markNotified, so a transient failure gets
      // another chance instead of being lost for good.
      throw new Error(`ntfy push failed: ${res.status} ${await res.text()}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
