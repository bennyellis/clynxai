// Photo cross-check for price data. A price only means something if it is the price of the RIGHT item: the Xbox Series S and
// the Xbox Series X have near-identical names and very different prices ($280 vs $500). Titles can't always tell them
// apart (sellers mistitle things, searches return siblings), but photos can. Before eBay sold comps and asking prices are
// averaged into a product's value, each result's photo is compared with the product's own reference photos in ONE vision
// call, and any result whose photo shows a different product is dropped.
import { OPENAI_MODEL, callOpenAI, ensureOpenAIAccess } from "./openai.js";
import { downloadImageAsDataUri, shrinkImageDataUri } from "./webResearch.js";

// For each item, false = its photo shows a DIFFERENT product (drop it); true = same product, unsure, or no photo to check.
export type PhotoCheck = (items: Array<{ title: string; imageUrl: string | null }>) => Promise<boolean[]>;

const PER_CALL = 14;
const MAX_CHECKED = 28;
const TIMEOUT_MS = 45_000;

async function askWhichAreDifferent(productName: string, referenceImages: string[], candidates: Array<{ title: string; pic: string }>): Promise<Set<number>> {
  const prompt = `A reseller is pricing the product "${productName}". The first ${referenceImages.length} photo(s) below are reference photos of EXACTLY that product. After them come ${candidates.length} numbered eBay listing photos with their titles.

For each numbered listing, decide whether its photo shows the SAME product as the reference photos: the same model, generation and edition (and color, if the product's name gives one). A look-alike sibling is NOT the same product. Examples of different products: an Xbox Series S (small white box with a large round vent) vs an Xbox Series X (tall black tower); a PS5 Slim vs the original PS5; a 1TB vs a 4TB expansion card with different packaging; a GPU from another maker. Also different: accessories, boxes only, parts, games, or a bundle where the product isn't the main item.

Only list a listing as different when you can see it is. If the photo is unclear, or could be the same product, don't list it.

Respond with ONLY a JSON object: { "different": number[] } using the listing numbers (empty if none are different).`;

  const content: unknown[] = [{ type: "text", text: prompt }];
  referenceImages.forEach((img, i) => {
    content.push({ type: "text", text: `Reference photo ${i + 1}:` });
    content.push({ type: "image_url", image_url: { url: img, detail: "low" } });
  });
  candidates.forEach((c, i) => {
    content.push({ type: "text", text: `Listing ${i + 1}: ${c.title.slice(0, 120)}` });
    content.push({ type: "image_url", image_url: { url: c.pic, detail: "low" } });
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await callOpenAI(
      "chat",
      {
        model: OPENAI_MODEL,
        messages: [{ role: "user", content }],
        max_completion_tokens: 600,
        reasoning_effort: "minimal",
        response_format: { type: "json_object" },
      },
      controller.signal, "comparable photo check");
    if (!res.ok) return new Set();
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
    const list: unknown[] = Array.isArray(parsed.different) ? parsed.different : [];
    return new Set(list.filter((n): n is number => typeof n === "number" && n >= 1 && n <= candidates.length).map((n) => n - 1));
  } catch {
    return new Set();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Builds the cross-check for one product, or null when there is nothing to compare against (no reference photo). It never
 * blocks pricing: with no AI access, no usable photo, or any failure, an item is simply kept (the text checks already ran).
 */
export function makePhotoCheck(productName: string, referenceImages: string[]): PhotoCheck | null {
  if (referenceImages.length === 0) return null;
  return async (items) => {
    const verdicts = items.map(() => true);
    try {
      ensureOpenAIAccess();
    } catch {
      return verdicts;
    }
    const wanted = items
      .map((item, index) => ({ item, index }))
      .filter((x) => !!x.item.imageUrl)
      .slice(0, MAX_CHECKED);
    const pics = await Promise.all(
      wanted.map(async (x) => {
        const data = await downloadImageAsDataUri(x.item.imageUrl as string).catch(() => null);
        return data ? await shrinkImageDataUri(data, 320, 65).catch(() => data) : null;
      })
    );
    const usable = wanted.map((x, k) => ({ ...x, pic: pics[k] })).filter((x): x is typeof x & { pic: string } => !!x.pic);
    for (let start = 0; start < usable.length; start += PER_CALL) {
      const batch = usable.slice(start, start + PER_CALL);
      const different = await askWhichAreDifferent(
        productName,
        referenceImages,
        batch.map((b) => ({ title: b.item.title, pic: b.pic }))
      );
      different.forEach((k) => {
        verdicts[batch[k].index] = false;
      });
    }
    return verdicts;
  };
}
