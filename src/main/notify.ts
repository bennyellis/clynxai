import type { Config, ScoredListing, Watch } from "./types.js";
import type { AlertSummary } from "./dealSummary.js";
import { downloadImageBuffer } from "./webResearch.js";

// eBay Browse API integration — narrowed from EngineConfig (Config minus
// accounts, plus one Account) down to just what this file actually reads.
// EngineConfig was historically used here for no real reason beyond being
// what scrapeEngine.ts already had on hand — postNtfyMessage only ever
// touches config.ntfy.*, and an eBay-sourced alert has no Account/
// EngineConfig to pass in at all (eBay has no per-account model). This is
// the honest fix, not a workaround: the real, narrower requirement.
type NotifyConfig = Pick<Config, "ntfy">;

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

// Per explicit instruction — shared by sendDealAlert and sendWatchMatchAlert
// below: the actual POST to ntfy, with an optional photo attached as the
// request body (see downloadImageBuffer's own doc comment for why the real
// bytes are fetched and uploaded directly rather than pointing ntfy's own
// Attach-by-URL at a Facebook CDN link — that can require a referrer/
// session ntfy's server would never have). `message` may contain literal
// "\n" sequences — HTTP header VALUES can't hold a raw newline character,
// but ntfy's own server accepts an escaped "\n" inside the header and
// renders it as a real line break (verified live against a real ntfy.sh
// topic), which is what makes a genuinely multi-line notification body
// possible through a header at all.
async function postNtfyMessage(
  config: NotifyConfig,
  opts: { title: string; message: string; click: string; priority: string; tags: string; photoUrl: string | null; photoFilenamePrefix: string }
): Promise<void> {
  const photo = opts.photoUrl ? await downloadImageBuffer(opts.photoUrl) : null;

  const url = `${config.ntfy.server.replace(/\/$/, "")}/${config.ntfy.topic}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NTFY_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Title: encodeHeader(opts.title),
      Message: encodeHeader(opts.message),
      Click: encodeHeader(opts.click),
      Priority: opts.priority,
    };
    // ntfy turns each tag into an emoji; an unverified deal gets none (it used to get a thinking face).
    if (opts.tags) headers.Tags = opts.tags;
    // Presence of Filename is what tells ntfy the request body is a file
    // attachment rather than the message text — with no photo, the body is
    // left empty and Title/Message above carry the whole notification, same
    // as ntfy's own documented header-only (empty-body) usage.
    if (photo) headers.Filename = `${opts.photoFilenamePrefix}.${photo.contentType.split("/")[1] || "jpg"}`;

    const res = await fetch(url, {
      method: "POST",
      body: photo ? new Uint8Array(photo.buffer) : undefined,
      headers,
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

// Per explicit instruction — the two-line format (see dealSummary.ts for how each part is worked out):
//   🟦 $300 - Xbox Series X - Listed 2 hours ago      (🟦 Facebook, 🟩 eBay)
//   About $120 profit, sells in 1 day - ⭐⭐⭐⭐
// The product is the focal point of the listing, not its full title; the stars are Clynx's own verdict.
export async function sendDealAlert(config: NotifyConfig, scored: ScoredListing, summary: AlertSummary): Promise<void> {
  const { listing, dealTier } = scored;
  const isSearchMatch = dealTier === "search";
  await postNtfyMessage(config, {
    title: summary.title,
    message: summary.message,
    click: listing.url,
    priority: summary.stars >= 4 || isSearchMatch ? "high" : "default",
    tags: isSearchMatch ? "moneybag" : "",
    photoUrl: listing.imageUrls[0] ?? listing.thumbnailUrl,
    photoFilenamePrefix: "deal",
  });
}

// A Watch match uses the same two-line format as a deal alert (above); only the tag and priority differ.
export async function sendWatchMatchAlert(
  config: NotifyConfig,
  watch: Watch,
  scored: ScoredListing,
  _match: { discoveryMode: "passive" | "active"; discountPercentAtMatch: number | null; profitUsdAtMatch: number | null },
  _referencePriceUsd: number | null,
  summary: AlertSummary
): Promise<void> {
  const { listing } = scored;
  if (listing.price === null) return; // shouldn't happen — recordWatchMatchesIfAny already guards this, defensive only
  // A Watch can have its own ntfy topic (e.g. one run for a friend's area): its matches go there instead of the main topic.
  const target: NotifyConfig = watch.ntfyTopic?.trim() ? { ntfy: { ...config.ntfy, topic: watch.ntfyTopic.trim() } } : config;

  await postNtfyMessage(target, {
    title: summary.title,
    message: summary.message,
    click: listing.url,
    priority: "high",
    tags: "eye",
    photoUrl: listing.imageUrls[0] ?? listing.thumbnailUrl,
    photoFilenamePrefix: "watch-match",
  });
}
