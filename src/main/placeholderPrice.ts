// Placeholder prices. $0/$1 and 4+-digit repeated-or-sequential prices ($1111, $1234, $9999, $4321) are a well-known Facebook
// Marketplace pattern: the seller hasn't set a real price and wants offers ("best offer"), or is setting up an off-platform scam
// conversation. They are never a price a reseller can buy at and flip, so they are skipped everywhere a price is first read (the
// scanner, Watches, the eBay scanner) and, as a last safety net, before any notification goes out.
//
// The 4-digit floor matters: 2-3 digit repeats ($99, $555, $999) are very common, deliberate real price points ($999 was a false
// positive before the floor was added), not placeholders. Ordinary round prices ($100, $250, $500) are never caught by this.
export function isSuspiciousPrice(price: number): boolean {
  if (!Number.isFinite(price)) return false;
  if (price <= 1) return true;
  const digits = String(Math.round(price));
  if (digits.length < 4) return false;
  if (/^(\d)\1+$/.test(digits)) return true; // 1111, 9999, 5555, ...
  const nums = digits.split("").map(Number);
  const ascending = nums.every((d, i) => i === 0 || d === nums[i - 1] + 1);
  const descending = nums.every((d, i) => i === 0 || d === nums[i - 1] - 1);
  return ascending || descending; // 1234, 4321, ...
}

/** Why a placeholder price is skipped, in words for the Activity log: "$1234 looks like a placeholder price (sellers use these when they want offers)". */
export function placeholderPriceReason(price: number): string {
  return `$${price} looks like a placeholder price (sellers use these when they want offers instead of naming a price), not a real one`;
}
