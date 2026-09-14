// OpenAI-based photo analysis — the actual "look at the photos" capability,
// using the same paid provider and model as everything else in this app
// (see openai.ts). gpt-5-mini is natively multimodal, so this needs no
// separate provider/key the way Gemini did before switching everything to
// OpenAI.
import sharp from "sharp";
import { OPENAI_MODEL, OPENAI_URL, getOpenAIApiKey } from "./openai.js";

// Kept generous — a multi-photo, multi-item analysis is legitimately more
// work than a one-line text reply, so this is a real safety margin, not a
// number expected to be hit often.
const OPENAI_TIMEOUT_MS = 90_000;

export interface PhotoAnalysisResult {
  summary: string | null;
  // Per explicit instruction — "bring the app more to life": a short,
  // human, FIRST-PERSON reaction to this specific listing, written as an
  // expert Facebook Marketplace-to-eBay reseller would actually say it out
  // loud — not a restatement of `summary` (which stays a plain analytical
  // record). Shown live on Dashboard's Live panel under the listing being
  // evaluated (see scrapeEngine.ts's evaluateListing / ScrapeStatus.
  // currentReaction) while the AI has this listing's photos open. Null
  // whenever there's nothing worth reacting to, or analysis failed.
  expertTake: string | null;
  // Sellers routinely photograph bundled extras (games included with a
  // console being the classic case) without mentioning them anywhere in
  // the title or description — text-only matching has no way to catch
  // that, and it can easily be where the bulk of the resale profit
  // actually is. Structured (not just buried in the prose summary) so
  // scrapeEngine.ts can act on it directly — including using it as an
  // independent path to isDeal for a listing the price alone wouldn't
  // have qualified, not just a nice detail mentioned after the fact.
  hasValuableBundle: boolean;
  bundleDescription: string | null;
  // Per explicit instruction — "the switch itself might only be $120, but
  // there could be $200 worth of games": a boolean/description alone can't
  // feed into the actual discount math, so this is the AI's own best-guess
  // TYPICAL USED RESALE value of just the bundled extras (not the whole
  // lot) — added to a matched item's own reference price before comparing
  // against the asking price (see scrapeEngine.ts), instead of just
  // flipping isDeal true/false with no idea how much the bundle is
  // actually worth. Null whenever hasValuableBundle is false, or the model
  // couldn't put a number on it.
  bundleEstimatedValueUsd: number | null;
  // Every distinct, specific, individually-researchable product actually
  // visible in the photos — the real identification mechanism for the
  // Database now, in place of trusting the listing's own (often vague,
  // sometimes wrong) title/category. Not a literal web reverse-image-
  // search (that needs a separate paid service like Google Vision or Bing
  // Visual Search this app doesn't integrate) — this is the same vision
  // model actually looking at the photos and naming what it sees, which
  // gets the same practical result: an accurate product name driven by
  // the photos, not the text.
  identifiedProducts: string[];
  // Verified live miss: scrapeEngine.ts used to reuse ONE shared photo (the
  // listing's first image) as the Database thumbnail/reference for EVERY
  // identified product, regardless of which photo actually showed it — on
  // a listing depicting more than one distinct item (a console + a
  // separately-identified bundled game, say), that could attach a totally
  // wrong photo to a product (reported live: a "Nintendo 3DS" Database
  // entry showing a Call of Duty game case as its thumbnail). Maps each
  // identifiedProducts name to the SPECIFIC photo (already downloaded here,
  // as a ready-to-use data: URI) the model actually pointed to for it —
  // callers should look up a subject's own photo here instead of assuming
  // any particular index. A product with no confident single-photo match
  // (or one the model didn't attribute) simply has no entry. Per explicit
  // instruction, this is also now cropped down to just that product
  // whenever the model gave a usable bounding box for it (see
  // cropToBoundingBox) — a photo showing a console next to its bundled game
  // and controller ends up producing a separately-cropped, clutter-free
  // photo for each of the three, not the same group shot on all of them.
  // Falls back to the full uncropped photo if cropping wasn't possible.
  productPhotos: Record<string, string>;
  // Only meaningful when a claimedItem was actually passed in to compare
  // against (see analyzeListingPhotos) — null otherwise, or whenever the
  // photos genuinely can't confirm either way. False means the photos show
  // something MEANINGFULLY DIFFERENT/LESSER than what's claimed — e.g. a
  // listing titled/matched as "Xbox Series X" whose photos only show a
  // controller, not a console. Added after a live miss: exactly that case
  // got flagged as an 83%-under deal, since nothing was comparing what the
  // photos actually showed against what the discount math assumed was
  // being sold.
  matchesClaim: boolean | null;
  mismatchReason: string | null;
  // Only meaningful when referenceProducts was actually passed in (see
  // analyzeListingPhotos) — the name of one of those known Database
  // products, if the model thinks THIS listing's photos actually show it
  // despite an unrelated/vague title. Per explicit instruction: sometimes a
  // seller puts a bad or generic title on a listing that's genuinely a
  // product the user already cares about, and text-only matching has no
  // way to catch that — this compares against real reference photos
  // already confirmed for known products instead. Null when no reference
  // products were given, or none looked like a match.
  matchedKnownProduct: string | null;
  // Per explicit instruction — "sometimes the ai will come across sellers
  // that have videos in their listings... search through each image...
  // find the most relevant image to the listing title": the model looks
  // at EVERY downloaded photo (not just ones tied to a specific identified
  // product) and picks whichever one most clearly represents what the
  // listing's own TITLE claims to be selling overall — already downloaded
  // here as a ready-to-use data: URI, same pattern as productPhotos.
  // scrapeEngine.ts uses this as the general-purpose fallback/reference
  // photo instead of blindly grabbing the listing's first image, which
  // used to be exactly wrong whenever that first image was actually a
  // frame/thumbnail from a video the seller added rather than a genuine
  // standalone photo (a bad angle, mid-motion, or a paused intro screen).
  // Null if nothing among the photos clearly matches the title's claim.
  titleMatchPhoto: string | null;
  error: string | null;
}

function errorResult(error: string): PhotoAnalysisResult {
  return {
    summary: null,
    expertTake: null,
    hasValuableBundle: false,
    bundleDescription: null,
    bundleEstimatedValueUsd: null,
    identifiedProducts: [],
    productPhotos: {},
    matchesClaim: null,
    mismatchReason: null,
    matchedKnownProduct: null,
    titleMatchPhoto: null,
    error,
  };
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

interface DownloadedImage {
  mimeType: string;
  base64: string;
}

async function downloadImage(url: string): Promise<DownloadedImage | null> {
  try {
    const res = await fetchWithTimeout(url, 15_000);
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    if (!contentType.startsWith("image/")) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    // Generous but not unlimited — skip anything unusually large rather
    // than risk an oversized request.
    if (buffer.byteLength > 8 * 1024 * 1024) return null;
    return { mimeType: contentType, base64: buffer.toString("base64") };
  } catch {
    return null;
  }
}

// A tight region around one specific product within one specific photo —
// fractions of that photo's own width/height (0 to 1), top-left origin.
// Resolution-independent on purpose: the model is never told the photo's
// actual pixel dimensions, so it can only reason in fractions of the frame.
interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Per explicit instruction: a listing photo showing a console next to its
// bundled games/controller used to get attached, uncropped, to EVERY one of
// those products' Database entries — the console's reference photo would
// have a game case sitting right next to it in frame, and vice versa. This
// takes the model's own boundingBox for a product (see the prompt below)
// and actually crops the downloaded photo down to just that region before
// it's saved, instead of only ever handing back the whole original photo.
// Returns null (caller falls back to the uncropped photo) on anything that
// doesn't look like a real, useful crop — a malformed box, one so small it's
// probably a parsing glitch rather than a real product, or one that's
// basically the entire frame already (nothing to gain by cropping that).
function parseBoundingBox(raw: unknown): BoundingBox | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const x = Number(b.x);
  const y = Number(b.y);
  const width = Number(b.width);
  const height = Number(b.height);
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return null;
  if (x < 0 || y < 0 || width <= 0 || height <= 0) return null;
  // Tolerate tiny model overshoot past the frame edge, reject anything that
  // isn't at least roughly a real box within the photo.
  if (x > 1.05 || y > 1.05 || x + width > 1.1 || y + height > 1.1) return null;
  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
    width: Math.min(width, 1 - Math.max(0, x)),
    height: Math.min(height, 1 - Math.max(0, y)),
  };
}

// Small safety margin around the model's own box — its coordinates are an
// estimate, not a pixel-perfect measurement, and a hard crop right at the
// reported edge risks slicing a sliver off the actual product.
const CROP_PADDING_FRACTION = 0.04;

async function cropToBoundingBox(img: DownloadedImage, box: BoundingBox): Promise<string | null> {
  try {
    const buffer = Buffer.from(img.base64, "base64");
    const metadata = await sharp(buffer).metadata();
    const imgWidth = metadata.width;
    const imgHeight = metadata.height;
    if (!imgWidth || !imgHeight) return null;

    const padX = box.width * CROP_PADDING_FRACTION;
    const padY = box.height * CROP_PADDING_FRACTION;
    const x0 = Math.max(0, box.x - padX);
    const y0 = Math.max(0, box.y - padY);
    const x1 = Math.min(1, box.x + box.width + padX);
    const y1 = Math.min(1, box.y + box.height + padY);

    const left = Math.round(x0 * imgWidth);
    const top = Math.round(y0 * imgHeight);
    const width = Math.round((x1 - x0) * imgWidth);
    const height = Math.round((y1 - y0) * imgHeight);
    // Too small to plausibly be a real product on its own (likely a
    // parsing/estimation glitch) — not worth cropping to.
    if (width < 20 || height < 20) return null;
    // Already basically the whole photo — cropping would gain nothing.
    if (width >= imgWidth * 0.97 && height >= imgHeight * 0.97) return null;

    const cropped = await sharp(buffer).extract({ left, top, width, height }).jpeg({ quality: 90 }).toBuffer();
    return `data:image/jpeg;base64,${cropped.toString("base64")}`;
  } catch {
    // A crop failing (corrupt image, extract math landing just outside the
    // real bounds, etc.) should never take down the whole analysis — the
    // caller just keeps the uncropped photo instead.
    return null;
  }
}

// Analyzes up to `maxImages` photos from a listing together in one call —
// deliberately one request for the whole set (not per-photo) so the model
// can reason across them, e.g. "this is a console bundle, here's every
// individual game visible across these photos."
export async function analyzeListingPhotos(
  imageUrls: string[],
  // price added per explicit instruction — expertTake (see
  // PhotoAnalysisResult) is a reaction to the specific price/value
  // combination, which needs the actual asking price in hand, not just
  // what the photos show.
  context: { title: string; description: string; price: number | null },
  maxImages = 8,
  opts?: {
    // The product this listing is supposed to be, per its Search For match
    // — passed through so the model can flag a mismatch (see
    // PhotoAnalysisResult.matchesClaim) instead of just describing photos
    // in a vacuum.
    claimedItem?: string | null;
    // Confirmed-genuine reference photos of the claimedItem itself, from
    // its own Database entry (see store.ts's listProductImages) — real
    // photographic ground truth for the matchesClaim comparison above,
    // instead of relying purely on the model's own training-data idea of
    // what "claimedItem" looks like. Kept small by the caller (a couple of
    // photos at most).
    claimedItemReferenceImages?: string[];
    // A user-specified thing to actively check for in this product's real
    // listings — e.g. "games are often bundled in and add real resale
    // value, check for game cases/discs in the photos" — set on the
    // product's own Database page (see chat.ts's add_product_watch_note)
    // and looked up fresh per-listing, so it takes effect immediately, live,
    // the moment it's added, not just on the next research pass.
    watchFor?: string | null;
    // A small, bounded set of already-tracked Database products, each with
    // one confirmed-genuine reference photo (see store.ts's
    // listProductsWithImages) — only meaningful for an UNMATCHED listing
    // (no Search For hit), per explicit instruction: a seller sometimes
    // puts a vague or flat-out wrong title on a listing that's genuinely a
    // product the user already cares about, and this is what actually
    // catches that — comparing THIS listing's photos against real photos
    // of known products, not just guessing from text. Kept small by the
    // caller (a handful of products, one photo each) since every entry
    // here is an extra image in the same request.
    referenceProducts?: Array<{ name: string; imageDataUri: string }>;
    // Per explicit instruction — set when scraper.ts detected a <video>
    // element on the listing page, so the prompt can warn the model that
    // one of these "photos" might actually be a frame/thumbnail pulled
    // from that video rather than a genuine standalone photo, and to
    // weight bestTitleMatchPhotoNumber accordingly.
    hasVideo?: boolean;
  }
): Promise<PhotoAnalysisResult> {
  let apiKey: string;
  try {
    apiKey = getOpenAIApiKey();
  } catch (err) {
    return errorResult((err as Error).message);
  }
  if (!imageUrls.length) {
    return errorResult("No photos to analyze.");
  }

  const downloads = await Promise.all(imageUrls.slice(0, maxImages).map(downloadImage));
  const images = downloads.filter((d): d is DownloadedImage => d !== null);
  if (!images.length) {
    return errorResult("Couldn't download any of the listing's photos (may have expired or require auth).");
  }

  const claimedItem = opts?.claimedItem?.trim() || null;
  const watchFor = opts?.watchFor?.trim() || null;
  const referenceProducts = opts?.referenceProducts?.filter((r) => r.name.trim() && r.imageDataUri) ?? [];
  const claimedItemReferenceImages = claimedItem ? (opts?.claimedItemReferenceImages ?? []).filter(Boolean) : [];
  const hasVideo = !!opts?.hasVideo;

  const prompt = `You're looking at ${images.length} photo(s), numbered 1 to ${images.length} in the order shown below, from a single Facebook Marketplace listing titled "${context.title}", asking price ${context.price !== null ? `$${context.price}` : "not listed"}. Listing text: "${context.description.slice(0, 500)}"

Your main job: identify the focal product(s) actually being SOLD in these photos — treat the photos as the source of truth, not the title/text, which can be vague, incomplete, or wrong. Look at every photo carefully and read any visible text on boxes, cases, labels, or screens (e.g. game titles, model numbers, serial numbers shown in a settings screen) to identify the main item, plus any other item pictured that is itself a genuinely separate, individually-resalable product line (an extra game, a second device, etc.) even if the title/text never mentioned it. Note anything that confirms or contradicts what the listing title/text claims, and any visible damage not mentioned in the text.

Accuracy matters far more than completeness here — a wrong identification is worse than a missed one. A few things that specifically cause mistakes, so watch for them: (1) a game's box art, case, or cartridge is a DIFFERENT, SEPARATE item from the console/device it's played on — never call a game case "a [console name]" or vice versa just because they're photographed together; (2) don't let one photo's item bleed into your read of another — judge each photo on what IS actually pictured in it, not what you'd expect given the listing title; (3) if you're not genuinely confident what something specifically is, leave it out entirely rather than guessing your closest match; (4) distinguish the focal product(s) actually being sold from low-value parts/necessities that merely come with them — a power cable, AC adapter, charger, sensor bar, mount, stand, or carrying case is NOT its own product, it's a necessity/accessory for the item it belongs to, and must never appear in identifiedProducts on its own. This does NOT extend to a game, or an extra/second controller or gamepad bundled in alongside the main device (e.g. a Nintendo Switch Pro Controller, a spare Xbox controller) — those genuinely have their own independent resale value and ARE their own product, exactly like a bundled game would be, so identify them the same way: their own entry in identifiedProducts, their own representative photo, their own cropped boundingBox (see below). Only list something in identifiedProducts if it's a genuinely separate, individually-resalable product line in its own right — the main device itself, or a distinct bundled item people commonly buy/sell independently (a specific game title, an extra controller, a second device, and so on). If you're unsure whether something is its own product or just a low-value accessory for one already on your list, treat it as an accessory and leave it out — mention it in the summary/bundleDescription instead, since a complete accessory set can still matter for resale value even though it isn't its own Database entry. (The one exception: if a listing's photos show ONLY an accessory, with no main device present at all, then that accessory IS the focal item actually being sold, and should be identified normally.)

Name each product using ONLY its own canonical, generic model name — the name a retailer would use, e.g. "Nintendo 3DS" or "Xbox Series X" or "iPhone 15 Pro Max" or "PS5 Slim Digital Edition." NEVER fold condition ("open", "used", "like new") or the listing's own throwaway phrasing/bundle wording into the name itself — e.g. "Blue Nintendo 3DS (open) — handheld console" is wrong, it should just be "Nintendo 3DS" (never for a cosmetic color/finish with no real resale-value difference, or the listing's own condition claims). Per explicit instruction — verified miss: a black and a white Xbox Series S look like "the same product, different color" but genuinely do NOT resell for the same price (black commands a real premium) — this went unrecognized entirely because color was always dropped from the name. So: DO include the color/finish in the name whenever you know (from general knowledge of this product) that color is a genuine, meaningfully different-VALUED variant, not just a cosmetic preference — e.g. "Xbox Series S (Black)" vs "Xbox Series S (White)," a specific limited-edition colorway of a console or sneaker, a "(PRODUCT)RED" iPhone. If a color has no real resale-value distinction (most clothing, most generic electronics), leave it out exactly as before. When genuinely unsure whether a color carries a value difference, leave it out rather than guessing. The same precision applies to accessories, not just the main device: a game controller/gamepad specifically, this matters — look for the actual model markings/branding/distinctive design (extra paddles/buttons on the back, a different textured grip, a swappable-faceplate look) that would tell an "Xbox Elite Series 2 Controller" apart from a plain "Xbox Wireless Controller," or a PS5 "DualSense Edge" apart from a standard "DualSense" — these are genuinely different, differently-valued products, not the same accessory in different photos, so never collapse a premium/distinct controller edition down to the generic base name just because they're broadly "the same kind of accessory." If you can't tell which specific edition it is, fall back to the plain base name rather than guessing a premium edition it might not be. This matters beyond just this one response: the exact string you use here is what a persistent product database gets filed under, and inconsistent or listing-specific naming creates duplicate entries for the same real product instead of building up one real one.

For each product in identifiedProducts, also give a tight bounding box around JUST that product within its representative photo (see photoAttribution below) — this app crops the photo down to that box before saving it as that product's reference image. A single photo showing a console sitting next to its bundled game and controller should end up producing three clean, individually-cropped photos (one per product), not the same cluttered group shot attached to all three. Draw the box tightly around that product's own visible extent ONLY — exclude every other item in the frame, even one you're also separately identifying, even if it's touching or right next to the target. Coordinates are fractions of the photo's own full width/height (0 to 1), measured from the top-left corner: x/y is the box's top-left corner, width/height is its size (e.g. a box covering the left third of a photo, full height, would be roughly {"x": 0, "y": 0, "width": 0.33, "height": 1}). If a product already fills essentially the entire photo on its own with nothing else in frame, the box can just cover the whole thing.

Sellers very often photograph extras included with the main product without ever listing them in the text, and those extras can easily be worth more than the base item itself (e.g. a handful of games bundled with a console). Don't guess or assume something exists — only report an item if you can actually make out what it specifically is in the photos. When you do find a valuable bundle, also put a real number on it (bundleEstimatedValueUsd) — your best-guess TYPICAL USED resale value of just those extras, not the whole lot — so the asking price can actually be weighed against the base item's value PLUS what's bundled in, not just a yes/no note.

Separately from the per-product photos above: look across ALL ${images.length} photo(s) and pick whichever ONE most clearly and directly represents what this listing's own TITLE ("${context.title}") is selling overall — this becomes the listing's general-purpose representative photo, used whenever nothing more specific applies. Prefer a clear, well-lit, standalone shot of the item over a busy group shot, an extreme close-up, or a photo of paperwork/packaging alone.${
    hasVideo
      ? ` IMPORTANT: this listing also includes a VIDEO, and it's likely that one of these numbered photos is actually a frame or thumbnail pulled from that video rather than a genuine standalone photo the seller took — such a frame is often a bad angle, blurry, mid-motion, or a paused intro/title screen. Actively avoid picking one of those for bestTitleMatchPhotoNumber whenever a genuine standalone photo of the item is available among the others, even if the video frame happens to appear first.`
      : ""
  }
${
  claimedItem
    ? `\nThis listing is supposed to be a "${claimedItem}". Check carefully whether the photos actually show that — a common scam/mistake pattern is a listing titled/matched as a full item (e.g. a game console) whose photos actually show only a minor accessory for it (e.g. just a controller or a cable), which is worth far less. Base this purely on what the photos themselves show — never on how good a price sounds; a steep discount is not evidence of a mismatch, and this business exists specifically to find those. If the photos clearly show something meaningfully different or lesser than "${claimedItem}" itself, set matchesClaim to false and explain what they actually show instead. If the photos are consistent with it (even if you can't be 100% certain), set matchesClaim to true.${
        claimedItemReferenceImages.length
          ? ` You'll also see ${claimedItemReferenceImages.length} confirmed-genuine reference photo(s) of a real "${claimedItem}" right after the listing's own photos — use those as concrete ground truth for this comparison, not just your general knowledge of what one looks like.`
          : ""
      }\n`
    : ""
}${watchFor ? `\nThe user has specifically asked to watch for this in listings of this product: "${watchFor}". Check the photos carefully for it and mention what you find either way.\n` : ""}${
    referenceProducts.length
      ? `\nAfter the listing's own photos above, you'll see ${referenceProducts.length} reference photo(s) of products the user already tracks, each labeled with its name. This listing has no confirmed match yet — sellers sometimes put a vague or wrong title on a listing that's actually one of these. Compare the listing's OWN photos against each reference photo: if the listing genuinely appears to show the same product as one of them, set matchedKnownProduct to that exact name. Only do this if you're reasonably confident — a passing resemblance isn't enough, and leaving it null is fine (and expected most of the time).\n`
      : ""
  }
Be concrete and specific — list what you actually see, don't guess at things you can't make out. If a photo is too blurry/small to read something, say so rather than inventing it.

Separately, give your own gut reaction (expertTake) to THIS listing — write it the way a sharp, experienced Facebook-Marketplace-to-eBay reseller would actually think out loud on seeing these exact photos at this exact asking price, not a neutral restatement of the summary above. Have real opinions: genuinely excited about a strong flip, wary of a sketchy or overpriced listing, unimpressed by a dud, whatever the price/condition/photos actually support. 1-2 sentences, plain conversational language, first person.

Respond with ONLY a JSON object, no other text, in this exact shape:
{
  "summary": string,               // everything you found, in prose — items visible, identifying details, condition, anything confirming/contradicting the listing text
  "expertTake": string,             // your own short, human, FIRST-PERSON reaction to THIS listing — 1-2 sentences, written the way a sharp, opinionated Facebook-Marketplace-to-eBay reseller would actually say it out loud on seeing these photos (excited about a good find, skeptical of a sketchy one, unimpressed by an overpriced dud, whatever's genuinely warranted) — not a restatement of summary, and not generic ("looks fine"). React to the SPECIFIC price/condition/value combination in front of you.
  "identifiedProducts": string[],  // ONLY the focal product(s) actually being sold, plus any other genuinely separate, individually-resalable product line pictured (e.g. an extra game, an extra controller) — canonical name only, see above, e.g. ["PlayStation 5 Slim Digital Edition", "Spider-Man 2 (PS5)", "God of War Ragnarok (PS5)"]. NEVER include low-value necessities that merely come with the main item (power cords, AC adapters, chargers, sensor bars, mounts, cases, etc.) — those belong in bundleDescription instead, not here. Empty array if you can't confidently identify anything specific.
  "photoAttribution": [ { "photoNumber": number, "product": string, "boundingBox": { "x": number, "y": number, "width": number, "height": number } } ],  // for EACH photo (by its number, 1 to ${images.length}, matching the order shown) that clearly and specifically depicts ONE of the products listed in identifiedProducts, pair its number with that EXACT product string (must match identifiedProducts verbatim) and a tight boundingBox around just that product within that photo — see above. Skip any photo that doesn't clearly show one specific identifiedProducts item on its own (an angle shot of the same item already covered elsewhere is fine to skip — this is about finding at least one good representative photo per product, not labeling every photo). Empty array if nothing qualifies.
  "hasValuableBundle": boolean,     // true ONLY if photos show specific additional items bundled in (games, accessories, etc.) NOT mentioned in the title/description, that would meaningfully add to resale value beyond the base item alone
  "bundleDescription": string,      // if hasValuableBundle is true: specifically what's included, read as precisely as you can (e.g. "Includes 4 games visible in the photo: Zelda BOTW, Mario Kart 8, Smash Bros Ultimate, Animal Crossing"). Empty string if hasValuableBundle is false.
  "bundleEstimatedValueUsd": number | null,  // if hasValuableBundle is true: your best-guess TYPICAL USED resale value, in whole US dollars, of JUST the bundled extras you listed above (not the main item, not the total) — e.g. those 4 games together might typically resell for around 80 used. A real number estimate, not a range string. Null if hasValuableBundle is false or you genuinely can't estimate it.
  "matchesClaim": boolean | null,   // ${claimedItem ? `whether the photos are consistent with this actually being a "${claimedItem}" — see above` : "null — no claimed item was given to compare against"}
  "mismatchReason": string,         // if matchesClaim is false: what the photos actually show instead, plainly. Empty string otherwise.
  "matchedKnownProduct": string | null,  // ${referenceProducts.length ? "the exact name of a reference product above, ONLY if this listing's photos genuinely appear to show it — see above" : "null — no reference products were given to compare against"}
  "bestTitleMatchPhotoNumber": number | null  // the ONE photo number (1 to ${images.length}) that most clearly represents what the listing's title is selling overall — see above.${hasVideo ? " Avoid a video frame/thumbnail if a genuine standalone photo is available." : ""} Null only if none of the photos usefully represent it at all.
}`;

  const content: unknown[] = [{ type: "text", text: prompt }];
  for (const img of images) {
    content.push({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.base64}` } });
  }
  for (const dataUri of claimedItemReferenceImages) {
    content.push({ type: "text", text: `Confirmed-genuine reference photo of a real "${claimedItem}":` });
    content.push({ type: "image_url", image_url: { url: dataUri } });
  }
  for (const ref of referenceProducts) {
    content.push({ type: "text", text: `Reference photo — known product "${ref.name}":` });
    content.push({ type: "image_url", image_url: { url: ref.imageDataUri } });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: "user", content }],
        max_completion_tokens: 2048,
        // gpt-5-mini is a reasoning model — verified live it silently burns
        // the whole completion-token budget on invisible reasoning tokens
        // without this (see openai.ts). Photo analysis is heavier than a
        // one-line reply, so maxOutputTokens stays generous regardless.
        reasoning_effort: "minimal",
        // Native structured-output mode — more reliable than regex-
        // extracting JSON out of free text, which is what the previous
        // (Gemini) implementation had to do.
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return errorResult(`OpenAI API error ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) {
      return errorResult("OpenAI returned an empty response.");
    }
    try {
      const parsed = JSON.parse(text);
      const identifiedProducts: string[] = Array.isArray(parsed.identifiedProducts)
        ? parsed.identifiedProducts.filter((p: unknown): p is string => typeof p === "string" && p.trim().length > 0).map((p: string) => p.trim())
        : [];
      // Maps each attributed product name to the SPECIFIC downloaded photo
      // the model pointed to (1-indexed, matching the order actually shown
      // in the prompt) — see PhotoAnalysisResult.productPhotos. Only trusts
      // an entry whose product string exactly matches something in
      // identifiedProducts and whose photoNumber is a real index into the
      // photos actually sent, so a malformed/hallucinated entry just gets
      // silently dropped rather than attaching a wrong photo. Starts every
      // entry as the full, uncropped photo (a safe default), then — per
      // explicit instruction, so a photo showing a console next to its
      // bundled game/controller doesn't attach that same cluttered shot to
      // all of them — replaces it with a tight crop around just that
      // product whenever the model gave a usable boundingBox for it (see
      // cropToBoundingBox above); a missing/unusable box just leaves the
      // uncropped fallback in place rather than failing the whole entry.
      const productPhotos: Record<string, string> = {};
      const cropTasks: Promise<void>[] = [];
      if (Array.isArray(parsed.photoAttribution)) {
        for (const entry of parsed.photoAttribution) {
          const num = Number(entry?.photoNumber);
          const product = typeof entry?.product === "string" ? entry.product.trim() : "";
          if (!product || !identifiedProducts.includes(product)) continue;
          if (!Number.isInteger(num) || num < 1 || num > images.length) continue;
          if (productPhotos[product]) continue; // first attribution wins if the model names one twice
          const img = images[num - 1];
          productPhotos[product] = `data:${img.mimeType};base64,${img.base64}`;
          const box = parseBoundingBox(entry?.boundingBox);
          if (box) {
            cropTasks.push(
              cropToBoundingBox(img, box).then((cropped) => {
                if (cropped) productPhotos[product] = cropped;
              })
            );
          }
        }
      }
      await Promise.all(cropTasks);

      // Per explicit instruction — resolved the same way productPhotos
      // entries are, but uncropped (this is a whole-listing representative
      // photo, not a single product's own cropped reference shot) and only
      // trusted when it's a real index into the photos actually sent.
      const titleMatchNum = Number(parsed.bestTitleMatchPhotoNumber);
      const titleMatchPhoto =
        Number.isInteger(titleMatchNum) && titleMatchNum >= 1 && titleMatchNum <= images.length
          ? `data:${images[titleMatchNum - 1].mimeType};base64,${images[titleMatchNum - 1].base64}`
          : null;

      const hasValuableBundle = !!parsed.hasValuableBundle;
      const bundleEstimateNum = Number(parsed.bundleEstimatedValueUsd);
      return {
        summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : text.trim(),
        expertTake: typeof parsed.expertTake === "string" && parsed.expertTake.trim() ? parsed.expertTake.trim() : null,
        identifiedProducts,
        productPhotos,
        hasValuableBundle,
        bundleDescription: typeof parsed.bundleDescription === "string" && parsed.bundleDescription.trim() ? parsed.bundleDescription.trim() : null,
        bundleEstimatedValueUsd: hasValuableBundle && Number.isFinite(bundleEstimateNum) && bundleEstimateNum > 0 ? bundleEstimateNum : null,
        matchesClaim: claimedItem && typeof parsed.matchesClaim === "boolean" ? parsed.matchesClaim : null,
        mismatchReason: typeof parsed.mismatchReason === "string" && parsed.mismatchReason.trim() ? parsed.mismatchReason.trim() : null,
        matchedKnownProduct:
          referenceProducts.length && typeof parsed.matchedKnownProduct === "string" && parsed.matchedKnownProduct.trim()
            ? parsed.matchedKnownProduct.trim()
            : null,
        titleMatchPhoto,
        error: null,
      };
    } catch {
      // Shouldn't happen with response_format: json_object, but still
      // useful as a free-text summary if it ever does.
      return {
        summary: text.trim(),
        expertTake: null,
        hasValuableBundle: false,
        bundleDescription: null,
        bundleEstimatedValueUsd: null,
        identifiedProducts: [],
        productPhotos: {},
        matchesClaim: null,
        mismatchReason: null,
        matchedKnownProduct: null,
        titleMatchPhoto: null,
        error: null,
      };
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return errorResult(`OpenAI request timed out after ${OPENAI_TIMEOUT_MS / 1000}s`);
    }
    return errorResult((err as Error).message);
  } finally {
    clearTimeout(timeout);
  }
}

export interface ImageEligibilityResult {
  // True when the photo itself shows something a mail-order reseller could
  // never buy/ship — independent of whatever the title says.
  ineligible: boolean;
  category: string | null; // short guess, e.g. "boat", "sofa", "house"
  reason: string | null; // one-line explanation, shown back to the user
  error: string | null;
}

function imageEligibilityError(error: string): ImageEligibilityResult {
  return { ineligible: false, category: null, reason: null, error };
}

// Per explicit instruction: the scanner should recognize an unshippable/
// ineligible category (a car, a boat, real estate, furniture, ...) from a
// listing's PHOTO alone, before the listing is even opened — a seller can
// easily omit any hint of this from the title itself (a boat titled just
// "must sell fast, $2200"), so scrapeEngine.ts's title-keyword matching
// (UNSHIPPABLE_PATTERNS) has no way to catch that case on its own. This
// takes just the single cheap thumbnail already shown on the browse-results
// page (no need to open the listing to get it), one call, deliberately
// small/cheap compared to analyzeListingPhotos above (which looks at every
// photo on the full detail page for a much richer analysis, and still runs
// afterward for anything that gets this far).
export async function classifyThumbnailImage(
  thumbnailDataUri: string,
  title: string,
  // A small, bounded set of images already confirmed-or-guessed ineligible
  // (see store.ts's listBlacklistedImages) — passed in as real reference
  // examples so "next time it sees something similar" is an actual visual
  // comparison, not just an independent guess every time. Kept small by the
  // caller since every entry here is an extra image in the request.
  referenceIneligibleImages: Array<{ imageDataUri: string; category: string | null }> = []
): Promise<ImageEligibilityResult> {
  let apiKey: string;
  try {
    apiKey = getOpenAIApiKey();
  } catch (err) {
    return imageEligibilityError((err as Error).message);
  }

  const prompt = `You're looking at the thumbnail photo for a Facebook Marketplace listing titled "${title}". A mail-order reseller buys items here and ships them out by mail — they can never buy/resell a vehicle, boat, piece of real estate/property, or a bulky local-pickup-only item like furniture, a large appliance, a hot tub, a pool table, or similar. Your only job: does THIS PHOTO show one of those ineligible categories, regardless of what the title says (titles often leave this out entirely)?
${
  referenceIneligibleImages.length
    ? `\nAfter this listing's own thumbnail, you'll see ${referenceIneligibleImages.length} reference photo(s) already confirmed as ineligible, each labeled with its category. If this listing's photo genuinely looks like the same kind of thing as one of them, that's a strong signal to flag it too.\n`
    : ""
}
Be conservative — only flag something you can actually see clearly, not a guess. A photo of a small resalable item (electronics, tools, toys, clothing, collectibles, etc.) is NOT ineligible even if the background happens to show furniture or a house behind it — judge what's being SOLD, not what's in the background.

Respond with ONLY a JSON object, no other text, in this exact shape:
{
  "ineligible": boolean,
  "category": string,   // short category if ineligible, e.g. "boat", "sofa", "house" — empty string otherwise
  "reason": string       // one plain sentence explaining what you see — empty string if not ineligible
}`;

  const content: unknown[] = [
    { type: "text", text: prompt },
    { type: "image_url", image_url: { url: thumbnailDataUri } },
  ];
  for (const ref of referenceIneligibleImages) {
    content.push({ type: "text", text: `Reference photo — already confirmed ineligible category "${ref.category ?? "unknown"}":` });
    content.push({ type: "image_url", image_url: { url: ref.imageDataUri } });
  }

  // Shorter timeout than the full analyzeListingPhotos above — this is one
  // small image and a short answer, and it sits directly in front of every
  // listing evaluation (see evaluateListing), so a hung request here
  // shouldn't be allowed to stall the scanner nearly as long as the much
  // heavier full-detail photo analysis is allowed to.
  const timeoutMs = 30_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: "user", content }],
        max_completion_tokens: 400,
        reasoning_effort: "minimal",
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return imageEligibilityError(`OpenAI API error ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) return imageEligibilityError("OpenAI returned an empty response.");
    try {
      const parsed = JSON.parse(text);
      return {
        ineligible: !!parsed.ineligible,
        category: typeof parsed.category === "string" && parsed.category.trim() ? parsed.category.trim() : null,
        reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : null,
        error: null,
      };
    } catch {
      return imageEligibilityError("Couldn't parse the AI's response.");
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return imageEligibilityError(`OpenAI request timed out after ${timeoutMs / 1000}s`);
    }
    return imageEligibilityError((err as Error).message);
  } finally {
    clearTimeout(timeout);
  }
}

export interface ImageQuestionResult {
  answer: string | null;
  error: string | null;
}

// Per explicit instruction — every image the AI pulls into the Database
// gets its own "ask about this image" box in the enlarged (lightbox) view,
// so the user can get a real, specific answer about anything they're
// unsure of (a model number, a scuff, whether a port matches a particular
// generation) without leaving the page or guessing themselves. Uses the
// SAME vision model as everything else in this file, just a single free-
// text question about a single photo instead of a fixed analysis shape.
export async function answerImageQuestion(imageDataUri: string, question: string, subjectName: string): Promise<ImageQuestionResult> {
  let apiKey: string;
  try {
    apiKey = getOpenAIApiKey();
  } catch (err) {
    return { answer: null, error: (err as Error).message };
  }

  const prompt = `You're looking at one photo currently filed in a resale Database under "${subjectName}". Someone asked this about it: "${question}"

Look closely at the photo — read any visible text, model numbers, labels, packaging, screens, ports, or condition details — and give a thorough, specific, DIRECT answer based only on what you can actually see. If the photo doesn't show enough to answer confidently, say so plainly (and what you'd need to see instead) rather than guessing.

Respond with ONLY a JSON object, no other text: { "answer": string }`;

  const content: unknown[] = [
    { type: "text", text: prompt },
    { type: "image_url", image_url: { url: imageDataUri } },
  ];

  const timeoutMs = 45_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: "user", content }],
        max_completion_tokens: 800,
        reasoning_effort: "minimal",
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { answer: null, error: `OpenAI API error ${res.status}: ${body.slice(0, 300)}` };
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) return { answer: null, error: "OpenAI returned an empty response." };
    try {
      const parsed = JSON.parse(text);
      const answer = typeof parsed.answer === "string" && parsed.answer.trim() ? parsed.answer.trim() : null;
      return answer ? { answer, error: null } : { answer: null, error: "Couldn't parse the AI's answer." };
    } catch {
      // Fall back to the raw text rather than failing outright — still a
      // real, readable answer even if it didn't come back as clean JSON.
      return { answer: text.trim(), error: null };
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return { answer: null, error: `OpenAI request timed out after ${timeoutMs / 1000}s` };
    }
    return { answer: null, error: (err as Error).message };
  } finally {
    clearTimeout(timeout);
  }
}

export interface ThumbnailVerification {
  matches: boolean;
  reason: string | null;
  error: string | null;
}

const THUMBNAIL_VERIFICATION_PROMPTS: Record<"product" | "brandLogo" | "group", (subject: string) => string> = {
  product: (subject) =>
    `You're checking a candidate Database thumbnail for the specific product "${subject}". It should be an actual photo (or a realistic product render) of that physical item itself — reject it if it's actually a brand/company logo or wordmark, an unrelated product, a screenshot of a webpage/search results, or a generic stock image of something else entirely.`,
  brandLogo: (subject) =>
    `You're checking a candidate logo image for the brand/company "${subject}". It should be that brand's own official logo or wordmark — a graphic mark representing the company/brand itself, containing or stylizing its name — reject it if it's actually a photo of one of their products, a building, a person, packaging, or an unrelated logo.`,
  group: (subject) =>
    `You're checking a candidate thumbnail meant to represent a general collection/category: "${subject}" — it should reasonably represent that whole grouping (not one unrelated single item, and not a brand logo/wordmark).`,
};

// Per explicit instruction — thumbnail-finding shouldn't rely purely on
// text-based signals (a search query, a URL pattern like ".svg" or the
// word "logo" in a filename) to decide a candidate image is right; this
// actually LOOKS at the downloaded candidate before webResearch.ts accepts
// it. Used for all three thumbnail-search paths there (a specific
// product's own photo, a brand's logo, and a folder-level "collection"
// photo like "Xbox games") — each text-matched candidate gets one quick
// vision check here, and the caller moves on to the next candidate on a
// confident "no" rather than accepting the first web result that merely
// LOOKED plausible from its URL alone. An `error` here (API hiccup, no key
// configured) is deliberately NOT the same as a rejection — the caller
// treats it as "couldn't verify, accept anyway" so a transient OpenAI
// issue can't silently break thumbnail-finding altogether; only an actual
// completed check that says `matches: false` should cause skipping ahead.
export async function verifyThumbnailCandidate(
  imageDataUri: string,
  subjectName: string,
  kind: "product" | "brandLogo" | "group"
): Promise<ThumbnailVerification> {
  let apiKey: string;
  try {
    apiKey = getOpenAIApiKey();
  } catch (err) {
    return { matches: false, reason: null, error: (err as Error).message };
  }

  const prompt = `${THUMBNAIL_VERIFICATION_PROMPTS[kind](subjectName)}

Look at the image and decide whether it actually matches what's described above.

Respond with ONLY a JSON object, no other text, in this exact shape:
{
  "matches": boolean,
  "reason": string   // one short plain sentence describing what you actually see
}`;

  const timeoutMs = 30_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageDataUri } },
            ],
          },
        ],
        max_completion_tokens: 300,
        reasoning_effort: "minimal",
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { matches: false, reason: null, error: `OpenAI API error ${res.status}: ${body.slice(0, 300)}` };
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) return { matches: false, reason: null, error: "OpenAI returned an empty response." };
    try {
      const parsed = JSON.parse(text);
      return { matches: !!parsed.matches, reason: typeof parsed.reason === "string" ? parsed.reason.trim() || null : null, error: null };
    } catch {
      return { matches: false, reason: null, error: "Couldn't parse the AI's response." };
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return { matches: false, reason: null, error: `OpenAI request timed out after ${timeoutMs / 1000}s` };
    }
    return { matches: false, reason: null, error: (err as Error).message };
  } finally {
    clearTimeout(timeout);
  }
}

export interface ImageFeedbackResult {
  // The canonical name this image should actually be filed under, if the
  // feedback (or the AI's own re-examination) indicates it's showing a
  // different, specific, identifiable product than where it currently
  // lives — null when nothing should move (the feedback was about
  // something else — quality, a preference, "not a big deal" — or the AI
  // still isn't confident enough to rename it to something specific).
  actualSubject: string | null;
  // A short, concrete note describing the mistake for future reference —
  // per explicit instruction, so the AI doesn't make the same mistake
  // again. Stored on the corrected-away-from product's own lookout notes
  // (see index.ts's images:feedback handler) so the next time photo
  // analysis runs against that product, this correction is right there in
  // its own context.
  note: string | null;
  error: string | null;
}

// Per explicit instruction: when the user gives feedback on an image (via
// the lightbox's "?" button), the AI needs to actually act on it — figure
// out where the image SHOULD live, and remember the mistake going forward
// — not just log the complaint. Re-examines the photo itself in light of
// the feedback (the user might be right, or might be pointing at something
// the AI can now see itself, having been told to look again), rather than
// trusting the feedback text blindly without checking it against the image.
export async function reconsiderImageFeedback(
  imageDataUri: string,
  currentLabel: string,
  feedback: string,
  knownProducts: string[]
): Promise<ImageFeedbackResult> {
  let apiKey: string;
  try {
    apiKey = getOpenAIApiKey();
  } catch (err) {
    return { actualSubject: null, note: null, error: (err as Error).message };
  }

  const prompt = `This photo is currently filed under "${currentLabel}" in a resale Database. Someone reviewing it gave this feedback: "${feedback}"

Look closely at the photo again with that feedback in mind — read any visible text, model numbers, screens, ports, packaging, or shape/size details that would confirm or rule out what it actually shows.

Decide what should happen:
1. If the photo genuinely shows a DIFFERENT, specific, identifiable product than "${currentLabel}" (not just a worse photo of the same thing), name it using ONLY its own canonical, generic model name — the name a retailer would use (no condition, color, or listing phrasing folded in). First check whether it matches one of these already-tracked products, and if so use that EXACT name verbatim: ${
    knownProducts.length ? knownProducts.map((n) => `"${n}"`).join(", ") : "(none tracked yet)"
  }.
2. If the feedback is about something other than misidentification (blurry, bad angle, wrong crop, just not a great photo, or you genuinely can't tell anything different from what's already on file), leave actualSubject null — there's nothing to move, just note it if useful.

Also write ONE short, concrete sentence a future automated check could actually use to avoid repeating this exact mistake — describe the specific visual confusion, not just "be more careful" (e.g. "A photo of a Nintendo DS Lite (single visible screen, rounded clamshell, no visible 3D toggle switch) was mistakenly filed under Nintendo 3DS XL — check for the 3D depth slider on the top screen's right edge before treating a clamshell handheld as a 3DS."). Leave it empty only if the feedback carries no reusable lesson (e.g. pure preference, nothing about identification).

Respond with ONLY a JSON object, no other text, in this exact shape:
{
  "actualSubject": string | null,
  "note": string
}`;

  const content: unknown[] = [
    { type: "text", text: prompt },
    { type: "image_url", image_url: { url: imageDataUri } },
  ];

  const timeoutMs = 45_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: "user", content }],
        max_completion_tokens: 600,
        reasoning_effort: "minimal",
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { actualSubject: null, note: null, error: `OpenAI API error ${res.status}: ${body.slice(0, 300)}` };
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) return { actualSubject: null, note: null, error: "OpenAI returned an empty response." };
    try {
      const parsed = JSON.parse(text);
      const actualSubject =
        typeof parsed.actualSubject === "string" && parsed.actualSubject.trim() ? parsed.actualSubject.trim() : null;
      const note = typeof parsed.note === "string" && parsed.note.trim() ? parsed.note.trim() : null;
      return { actualSubject, note, error: null };
    } catch {
      return { actualSubject: null, note: null, error: "Couldn't parse the AI's response." };
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return { actualSubject: null, note: null, error: `OpenAI request timed out after ${timeoutMs / 1000}s` };
    }
    return { actualSubject: null, note: null, error: (err as Error).message };
  } finally {
    clearTimeout(timeout);
  }
}
