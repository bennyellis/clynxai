import { generateProductSummary, generateProductSummaryFromWeb } from "./chat.js";
import { researchProductOnWeb, findProductImage } from "./webResearch.js";

export interface ProductLookupResult {
  aiSummary: string;
  category: string;
  family: string | null;
  // See chat.ts's ProductSummaryResult.isBrandFamily — whether family's
  // top-level segment is a real, logo-able brand rather than an invented
  // grouping. index.ts's runProductLookup (which has the DB access
  // lookupProduct itself doesn't) uses this to decide whether to fetch a
  // "<brand> logo" image for the family folder's own thumbnail.
  isBrandFamily: boolean;
  imageUrl: string | null;
}

// findProductImage now handles everything itself: downloading candidate
// URLs, vision-verifying each one (see webResearch.ts's
// findAndVerifyImage/verifyThumbnailCandidate), and returning the final
// data: URI directly — a hotlinked remote URL can silently stop rendering
// later for reasons entirely outside this app, so nothing here ever stores
// one directly. candidateUrl (researchProductOnWeb's own og:image find, if
// any) is passed in as the FIRST candidate to verify rather than trusted
// blindly — it still has to pass the same vision check as every other
// candidate. If nothing pans out, that's treated the same as never having
// found an image (null), not surfaced as a research failure — a missing
// photo shouldn't block everything else lookupProduct found.
async function resolveImage(candidateUrl: string | null, name: string): Promise<string | null> {
  return findProductImage(name, candidateUrl);
}

// A real, in-depth web search (specs/variants/common problems, plus a
// representative product photo — see webResearch.ts), not just the AI's
// own possibly-stale training knowledge. If the web search itself comes up
// empty, generateProductSummaryFromWeb quietly falls back to training-
// knowledge-only (generateProductSummary) rather than failing the whole
// lookup. Either way, resolveImage above gets its own separate shot at
// finding (and downloading) a photo — per explicit instruction, the
// product's photo is the click target for its whole Database entry now,
// not just a nice-to-have, so this makes a real effort to never leave one
// empty rather than accepting whatever the text-oriented search happened
// to find along the way.
export async function lookupProduct(name: string): Promise<ProductLookupResult> {
  try {
    const research = await researchProductOnWeb(name);
    const { summary, category, family, isBrandFamily } = await generateProductSummaryFromWeb(name, research.sources);
    const imageUrl = await resolveImage(research.imageUrl, name);
    return { aiSummary: summary, category, family, isBrandFamily, imageUrl };
  } catch (err) {
    try {
      const { summary, category, family, isBrandFamily } = await generateProductSummary(name);
      const imageUrl = await resolveImage(null, name);
      return { aiSummary: summary, category, family, isBrandFamily, imageUrl };
    } catch {
      return { aiSummary: `(Research failed: ${(err as Error).message})`, category: "Other", family: null, isBrandFamily: false, imageUrl: null };
    }
  }
}
