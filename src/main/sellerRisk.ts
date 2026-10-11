import type { SellerRiskConfig, SellerRiskResult, SellerSignals } from "./types.js";

// Deterministic checks against objective, transaction-relevant signals only
// (account age, rating, sales history, profile photo presence). No
// demographic or identity-based signals (sex, apparent age, name/ethnicity,
// family status) are evaluated here — see the conversation this was scoped
// from for why those were deliberately left out.
export function evaluateSellerRisk(seller: SellerSignals, config: SellerRiskConfig): SellerRiskResult {
  if (!config.enabled) return { passed: true, reasons: [] };

  const reasons: string[] = [];
  const currentYear = new Date().getFullYear();

  if (seller.joinedFacebookYear !== null) {
    const ageYears = currentYear - seller.joinedFacebookYear;
    if (ageYears < config.minAccountAgeYears) {
      reasons.push(`Facebook account is only ~${ageYears}y old (min ${config.minAccountAgeYears}y)`);
    }
  }
  // Unknown join date is not itself a failure — we didn't manage to scrape
  // it, which isn't the seller's fault.

  if (config.minRating !== null && seller.rating !== null && seller.rating < config.minRating) {
    reasons.push(`Rating ${seller.rating} is below minimum ${config.minRating}`);
  }

  if (config.minRatingCount !== null && seller.ratingCount !== null && seller.ratingCount < config.minRatingCount) {
    reasons.push(`Only ${seller.ratingCount} ratings (min ${config.minRatingCount})`);
  }

  if (config.maxRatingCount !== null && seller.ratingCount !== null && seller.ratingCount > config.maxRatingCount) {
    reasons.push(`${seller.ratingCount} ratings exceeds max ${config.maxRatingCount} (likely a reseller/high-volume account)`);
  }

  if (config.requireProfilePhoto && seller.hasProfilePhoto === false) {
    reasons.push("No profile photo detected");
  }

  return { passed: reasons.length === 0, reasons };
}

// Facebook Marketplace is full of scam bots posting high-ticket items at a suspiciously low price. They give
// themselves away by writing a phone number with the middle masked in asterisks (XXX**XXX**XXXX, to dodge
// Facebook's own filters), and usually joined Facebook this year. A listing like that is skipped outright: no
// blacklist term is added, since the product itself is fine and a real listing for it may turn up.
const MASKED_PHONE = /\d{3}\s*\*{2,3}\s*\d{3}\s*\*{2,3}\s*\d{4}/;

/** The reason to skip a listing as a scam bot, or null when it doesn't look like one. */
export function detectScamBot(text: string, seller?: { joinedFacebookYear: number | null }): string | null {
  const match = text.match(MASKED_PHONE);
  if (!match) return null;
  const joinedThisYear = seller?.joinedFacebookYear != null && seller.joinedFacebookYear >= new Date().getFullYear();
  return `likely scam bot: the listing has a masked phone number ("${match[0].replace(/\s+/g, "")}")${joinedThisYear ? ` and the account joined Facebook in ${seller?.joinedFacebookYear}` : ""}`;
}
