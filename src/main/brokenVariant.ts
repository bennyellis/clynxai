// Broken / "for parts" items as their own Database VARIANT of a product (not a separate product): "Xbox Series X (For Parts / Broken)"
// sits under "Xbox Series X" and carries what broken ones of it actually sell for on eBay, which is very different from a working
// unit (a console with a dead HDMI port still sells for a lot more than the 25% of working value Clynx otherwise assumes).

export const BROKEN_SUFFIX = "(For Parts / Broken)";

/** "Xbox Series X" -> "Xbox Series X (For Parts / Broken)" */
export function brokenVariantName(productName: string): string {
  const base = baseNameOfBrokenVariant(productName);
  return `${base} ${BROKEN_SUFFIX}`;
}

export function isBrokenVariantName(name: string): boolean {
  return /\(\s*for parts\s*\/\s*broken\s*\)\s*$/i.test(name.trim());
}

/** "Xbox Series X (For Parts / Broken)" -> "Xbox Series X"; a name that is not a broken variant comes back unchanged. */
export function baseNameOfBrokenVariant(name: string): string {
  return name.replace(/\s*\(\s*for parts\s*\/\s*broken\s*\)\s*$/i, "").trim();
}

// Wording that says the item itself does not work properly (a console that won't power on, a dead HDMI port), not cosmetic
// damage: a cracked screen on a phone that works is still a working phone. A "no / not / n't" right before the word cancels it
// ("works great, not broken").
const BROKEN_WORDS =
  /(?<!\bnot )(?<!\bno )(?<!n't )(?<!\bnever )\b(for parts|parts only|parts or repair|for repair|needs repair|repair needed|not working|non[- ]?working|doesn'?t (work|turn on|power on|read|charge)|won'?t (turn on|power on|boot|charge|read|work)|no power|dead|broken|faulty|defective|bricked|bad (hdmi|disc drive|drive))\b/i;

export function looksBroken(text: string): boolean {
  return BROKEN_WORDS.test(text);
}

// Titles that are a PART or an accessory of the product, not the product itself in a broken state.
const IS_A_PART_ONLY =
  /\b(motherboard|mainboard|logic board|faceplate|housing|shell only|backplate|heatsink|fan only|psu only|power supply only|replacement|case only|empty box|box only|skin|decal|cover only|stand only|charger only|cable only|manual only|controller only|lot of|steelbook|screen only|battery only|hdmi port only|disc drive only)\b/i;

/**
 * Does an eBay listing title look like a BROKEN / for-parts copy of exactly this product (the base name, e.g. "Xbox Series X")?
 * Plain text checks: every word of the name is in the title, the title says it is broken / for parts / not working, and it is
 * not a loose part or accessory. Hard facts (capacity, model letters, color) are checked by the caller with compMatchesSpecs.
 */
export function titleLooksLikeBrokenProduct(baseName: string, title: string, conditionSaysBroken = false): boolean {
  const wanted = baseName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 1 && !["the", "and", "for", "with", "of", "edition"].includes(w));
  if (wanted.length === 0) return false;
  const haystack = ` ${title.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  if (!wanted.every((w) => haystack.includes(w))) return false;
  // eBay's own condition field ("For parts or not working") can say it when the title does not.
  if (!conditionSaysBroken && !looksBroken(title)) return false;
  return !IS_A_PART_ONLY.test(title);
}
