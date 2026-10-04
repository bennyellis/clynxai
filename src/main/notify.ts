import type { Config, ScoredListing, SellerSignals, Watch } from "./types.js";
import { downloadImageBuffer } from "./webResearch.js";

// eBay Browse API integration — narrowed from EngineConfig (Config minus
// accounts, plus one Account) down to just what this file actually reads.
// EngineConfig was historically used here for no real reason beyond being
// what scrapeEngine.ts already had on hand — postNtfyMessage only ever
// touches config.ntfy.*, and an eBay-sourced alert has no Account/
// EngineConfig to pass in at all (eBay has no per-account model). This is
// the honest fix, not a workaround: the real, narrower requirement.
type NotifyConfig = Pick<Config, "ntfy">;

// Per explicit instruction — "build the notification gracefully based on
// available information": prefers Facebook's own rating/joined-year line
// when present, falls back to eBay's feedbackScore/feedbackPercentage line
// when THOSE are set instead (never both — an eBay listing never has
// rating/joinedFacebookYear, and a Facebook listing never has the eBay
// fields, see types.ts's SellerSignals), and omits the line entirely when
// neither platform's signals are available. Shared by sendDealAlert and
// sendWatchMatchAlert below so both alert formats stay consistent.
function buildSellerTrustLine(seller: SellerSignals): string | null {
  if (seller.rating !== null || seller.joinedFacebookYear !== null) {
    const ratingLabel = seller.rating !== null ? `${seller.rating.toFixed(1)}★${seller.ratingCount !== null ? ` (${seller.ratingCount})` : ""}` : "No rating";
    const joinedLabel = seller.joinedFacebookYear !== null ? `Joined ${seller.joinedFacebookYear}` : "Joined date unknown";
    return `${ratingLabel} • ${joinedLabel}`;
  }
  if (seller.ebayFeedbackPercentage !== undefined || seller.ebayFeedbackScore !== undefined) {
    const pct = seller.ebayFeedbackPercentage !== undefined ? `${seller.ebayFeedbackPercentage.toFixed(1)}% positive` : null;
    const count = seller.ebayFeedbackScore !== undefined ? `${seller.ebayFeedbackScore} rating${seller.ebayFeedbackScore === 1 ? "" : "s"}` : null;
    return [pct, count].filter((p): p is string => !!p).join(" • ") || null;
  }
  return null;
}

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
      Tags: opts.tags,
    };
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

export async function sendDealAlert(config: NotifyConfig, scored: ScoredListing): Promise<void> {
  const { listing, extraction, dealTier } = scored;

  const isSearchMatch = dealTier === "search";
  // Per explicit instruction — "DEAL! {Product} • $xxx • {Listing age}" as
  // the notification's own title, with seller trust signals right below it
  // as the message body — Title/Message map naturally onto ntfy's own
  // two-part shape (bold heading + body text below), replacing the earlier
  // single-line "[listed product] * {price} * {age}" format. matchedItem is
  // the clean tracked-item name for a search-tier deal; a general
  // (unverified) deal has no matchedItem, so it falls back to the listing's
  // own raw title.
  const productName = extraction.matchedItem ?? listing.title;
  const titleLine = `DEAL! ${productName} • $${listing.price} • ${listing.listingAge ?? "age unknown"}`;
  const sellerLine = buildSellerTrustLine(listing.seller) ?? "No seller info available";

  await postNtfyMessage(config, {
    title: titleLine,
    message: sellerLine,
    click: listing.url,
    priority: isSearchMatch ? "high" : "default",
    tags: isSearchMatch ? "moneybag" : "thinking",
    photoUrl: listing.imageUrls[0] ?? listing.thumbnailUrl,
    photoFilenamePrefix: "deal",
  });
}

// Per explicit instruction — Watch's own recognizable notification, format:
//   WATCH MATCH
//   {Product}
//   $price • distance • age
//   Typical resale: $X
//   Est. profit: ~$Y
//   Z% below market
//   Seller: ★rating • Joined year
// "Do not require every optional field to exist — build the notification
// gracefully based on available information": every line below the
// product/price line is independently omitted when its underlying data
// isn't available (no reference price, no discount, no seller rating, ...)
// rather than showing a blank or a placeholder. `distance` is left out
// entirely for a PASSIVE match (see scrapeEngine.ts's discoveryMode) —
// passive matching has no reliable per-listing distance to report (only
// the active scheduler, Phase 3, navigates to the watch's own resolved
// location, at which point a real distance figure becomes meaningful).
export async function sendWatchMatchAlert(
  config: NotifyConfig,
  watch: Watch,
  scored: ScoredListing,
  match: { discoveryMode: "passive" | "active"; discountPercentAtMatch: number | null; profitUsdAtMatch: number | null },
  referencePriceUsd: number | null
): Promise<void> {
  const { listing } = scored;
  if (listing.price === null) return; // shouldn't happen — recordWatchMatchesIfAny already guards this, defensive only

  const priceParts = [`$${listing.price}`, listing.listingAge ?? null].filter((p): p is string => !!p);
  const titleLine = `WATCH MATCH`;
  const trustLine = buildSellerTrustLine(listing.seller);
  const bodyLines = [
    watch.name,
    priceParts.join(" • "),
    referencePriceUsd !== null ? `Typical resale: $${referencePriceUsd.toFixed(0)}` : null,
    match.profitUsdAtMatch !== null ? `Est. profit: ~$${match.profitUsdAtMatch.toFixed(0)}` : null,
    match.discountPercentAtMatch !== null ? `${match.discountPercentAtMatch.toFixed(0)}% below market` : null,
    trustLine !== null ? `Seller: ${trustLine}` : null,
  ].filter((line): line is string => !!line);

  await postNtfyMessage(config, {
    // Literal two-character "\n" (not an actual newline byte): ntfy's server
    // converts this to a real line break on display (verified live), but a
    // real embedded newline is invalid inside a fetch() header value and
    // throws — Headers.append rejects it outright — unless encodeHeader's
    // non-ASCII check happens to trigger base64-wrapping first. A plain-ASCII
    // match (no age, no seller rating — nothing non-ASCII in any line) would
    // otherwise skip that wrapping and crash the whole send. The literal
    // escape is safe unconditionally, regardless of what else is in the body.
    title: titleLine,
    message: bodyLines.join("\\n"),
    click: listing.url,
    priority: "high",
    tags: "eye",
    photoUrl: listing.imageUrls[0] ?? listing.thumbnailUrl,
    photoFilenamePrefix: "watch-match",
  });
}
