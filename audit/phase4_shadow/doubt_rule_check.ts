// Read-only: how the "unconfirmed model number" rule behaves on the listings of a database COPY, before (every extra code) and after Stage 1.1 (only codes backed by
// evidence). Opens the copy read-only; touches nothing else.
//   node audit/phase4_shadow/build.cjs doubt_rule_check && node audit/phase4_shadow/doubt_rule_check.cjs <copy-of-scout.db>
import { DatabaseSync } from "node:sqlite";
import { codesMissingFrom } from "../../src/main/identity/codes.ts";
import { assessCodes, CodeIndex, type EvidenceDoc } from "../../src/main/identity/credibility.ts";
import { oldTitlePick } from "../../src/main/identity/shadow.ts";
import { compMatchesSpecs } from "../../src/main/compFilter.ts";

const dbPath = process.argv[2] ?? "C:/Users/biggt/ClynxDbCopy/scout.db";
if (/fb-marketplace-scout[\\/]+data[\\/]/i.test(dbPath)) {
  console.error("Refusing to run: give it a COPY of scout.db.");
  process.exit(2);
}
const db = new DatabaseSync(dbPath, { readOnly: true });
const prods = db.prepare("SELECT id, name, category FROM products").all() as Array<{ id: string; name: string; category: string }>;
const listings = db.prepare("SELECT id, title, seller_name, product_id FROM listings").all() as Array<{ id: string; title: string; seller_name: string | null; product_id: string | null }>;
const photos = db.prepare("SELECT product_id, source_title FROM product_images WHERE source_title IS NOT NULL").all() as Array<{ product_id: string; source_title: string }>;
db.close();

const docs: EvidenceDoc[] = [
  ...prods.map((p) => ({ text: p.name, origin: `product:${p.id}`, kind: "product" as const })),
  ...listings.map((l) => ({ text: l.title, origin: l.seller_name ? `seller:${l.seller_name.toLowerCase()}` : `title:${l.title.toLowerCase()}`, kind: "listing" as const })),
  ...photos.map((i) => ({ text: i.source_title, origin: `title:${i.source_title.toLowerCase()}`, kind: "photo" as const })),
];
const index = new CodeIndex(docs);
const shadowProds = prods.map((p) => ({ id: p.id, name: p.name, category: p.category, parentId: null, valueUsd: null, titles: [], compsIdentity: null }));
const byId = new Map(prods.map((p) => [p.id, p]));

let withEntry = 0, rawFlag = 0, credible = 0, unverified = 0, dismissed = 0;
const rows: string[] = [];
for (const l of listings) {
  const target = l.product_id ?? oldTitlePick(l.title, shadowProds as never, compMatchesSpecs);
  const entry = target ? byId.get(target) : undefined;
  if (!entry) continue;
  withEntry++;
  const raw = codesMissingFrom(entry.name, l.title);
  if (raw.length === 0) continue;
  rawFlag++;
  const a = assessCodes({ entryId: entry.id, entryName: entry.name, title: l.title, index, seller: l.seller_name });
  if (a.credible.length) credible++;
  else if (a.unverified.length) unverified++;
  else dismissed++;
  rows.push(
    `raw ${raw.join(",").padEnd(10)} -> ${a.credible.length ? "CREDIBLE " + a.credible.map((c) => `${c.code}(${c.reason}${c.siblingName ? ": " + c.siblingName : ""})`).join(",") : a.unverified.length ? "unverified " + a.unverified.map((u) => `${u.code}(${u.reason})`).join(",") : "dismissed " + a.dismissed.map((d) => `${d.code}(${d.reason})`).join(",")} | entry "${entry.name}" | "${l.title.slice(0, 64)}"`
  );
}
console.log(`listings with an entry: ${withEntry}`);
console.log(`BEFORE Stage 1.1 (any extra code downgrades + triggers research): ${rawFlag} listings (${((rawFlag / withEntry) * 100).toFixed(1)}%)`);
console.log(`AFTER: credible ${credible} (downgrade + research), unverified ${unverified} (note only), short-form/dismissed ${dismissed}`);
console.log(rows.join("\n"));
