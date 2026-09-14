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
