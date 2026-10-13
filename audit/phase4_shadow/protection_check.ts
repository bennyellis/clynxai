// Read-only leave-one-out check on a database COPY: do genuine model markers stay protected after Stage 1.1?
// For every pair (generic entry G, narrower entry S) where S's name states a code G's does not, S is treated as a listing title and S's own entry is
// HIDDEN from the evidence; the question is whether the rule still calls the code credible from everything else. That is the situation of a real new
// model seen for the first time. Also reports how often the code is credible when S is NOT hidden (a known sibling).
//   node audit/phase4_shadow/build.cjs protection_check && node audit/phase4_shadow/protection_check.cjs <copy-of-scout.db>
import { DatabaseSync } from "node:sqlite";
import { codesMissingFrom } from "../../src/main/identity/codes.ts";
import { assessCodes, CodeIndex, type EvidenceDoc } from "../../src/main/identity/credibility.ts";
import { compareIdentity } from "../../src/main/identity/resolver.ts";

const dbPath = process.argv[2] ?? "C:/Users/biggt/ClynxDbCopy/scout.db";
if (/fb-marketplace-scout[\\/]+data[\\/]/i.test(dbPath)) {
  console.error("Refusing to run: give it a COPY of scout.db.");
  process.exit(2);
}
const db = new DatabaseSync(dbPath, { readOnly: true });
const prods = db.prepare("SELECT id, name, category FROM products").all() as Array<{ id: string; name: string; category: string }>;
const listings = db.prepare("SELECT title, seller_name FROM listings").all() as Array<{ title: string; seller_name: string | null }>;
const photos = db.prepare("SELECT product_id, source_title FROM product_images WHERE source_title IS NOT NULL").all() as Array<{ product_id: string; source_title: string }>;
db.close();

const docsFor = (hideProductId: string | null): EvidenceDoc[] => [
  ...prods.filter((p) => p.id !== hideProductId).map((p) => ({ text: p.name, origin: `product:${p.id}`, kind: "product" as const })),
  ...listings.map((l) => ({ text: l.title, origin: l.seller_name ? `seller:${l.seller_name.toLowerCase()}` : `title:${l.title.toLowerCase()}`, kind: "listing" as const })),
  // photo titles filed under the hidden entry are hidden with it
  ...photos.filter((i) => i.product_id !== hideProductId).map((i) => ({ text: i.source_title, origin: `title:${i.source_title.toLowerCase()}`, kind: "photo" as const })),
];
const fullIndex = new CodeIndex(docsFor(null));

let pairs = 0, credibleKnown = 0, credibleHidden = 0, unverifiedHidden = 0;
const byCat: Record<string, { pairs: number; hiddenCredible: number }> = {};
const missed: string[] = [];
const seen = new Set<string>();
for (const g of prods) {
  for (const s of prods) {
    if (g.id === s.id) continue;
    const cmp = compareIdentity(g.name, s.name);
    if (cmp.level !== "line" || cmp.moreSpecific !== "b") continue; // s is narrower than g
    const codes = codesMissingFrom(g.name, s.name);
    if (codes.length === 0) continue;
    const key = `${g.id}|${s.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs++;
    const known = assessCodes({ entryId: g.id, entryName: g.name, title: s.name, index: fullIndex });
    if (known.credible.length) credibleKnown++;
    const hidden = assessCodes({ entryId: g.id, entryName: g.name, title: s.name, index: new CodeIndex(docsFor(s.id)) });
    const row = (byCat[s.category] ??= { pairs: 0, hiddenCredible: 0 });
    row.pairs++;
    if (hidden.credible.length) {
      credibleHidden++;
      row.hiddenCredible++;
    } else {
      if (hidden.unverified.length) unverifiedHidden++;
      if (missed.length < 14) missed.push(`${g.name}  ->  ${s.name}   [${codes.join(",")}]`);
    }
  }
}
console.log(`pairs where a Database entry is a narrower model carrying a code its generic entry lacks: ${pairs}`);
console.log(`credible when the narrower entry is known (normal operation): ${credibleKnown} (${((credibleKnown / Math.max(1, pairs)) * 100).toFixed(0)}%)`);
console.log(`credible with the narrower entry HIDDEN (first sighting of a real model): ${credibleHidden} (${((credibleHidden / Math.max(1, pairs)) * 100).toFixed(0)}%); left unverified (note only): ${unverifiedHidden}`);
console.log("by category (hidden):", JSON.stringify(byCat));
console.log("examples left unverified when first seen:\n  " + missed.join("\n  "));
