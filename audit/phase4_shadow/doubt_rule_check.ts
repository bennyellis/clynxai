// Read-only: how often would the slice-1 "unconfirmed code" rule fire on the listings in a database COPY, and on what kind of codes?
import { DatabaseSync } from "node:sqlite";
import { codesMissingFrom } from "../../src/main/identity/codes.ts";
import { oldTitlePick } from "../../src/main/identity/shadow.ts";
import { compMatchesSpecs } from "../../src/main/compFilter.ts";
const db = new DatabaseSync(process.argv[2] ?? "C:/Users/biggt/ClynxDbCopy/scout.db", { readOnly: true });
const prods = (db.prepare("SELECT id, name, category FROM products").all() as any[]).map((p) => ({ id: p.id, name: p.name, category: p.category, parentId: null, valueUsd: null, titles: [], compsIdentity: null }));
const byId = new Map(prods.map((p) => [p.id, p.name]));
const listings = db.prepare("SELECT id, title, price, product_id, is_deal, deal_status FROM listings").all() as any[];
let withEntry = 0, flagged = 0;
const rows: string[] = [];
for (const l of listings) {
  const target = l.product_id ?? oldTitlePick(l.title, prods as any, compMatchesSpecs);
  const name = target ? byId.get(target) : undefined;
  if (!name) continue;
  withEntry++;
  const extra = codesMissingFrom(name, l.title);
  if (extra.length) { flagged++; rows.push(`${extra.join(",").padEnd(16)} | entry "${name}" | "${String(l.title).slice(0, 70)}" | deal=${l.is_deal} status=${l.deal_status}`); }
}
console.log(`listings with an entry: ${withEntry} of ${listings.length}; flagged by the slice-1 doubt rule: ${flagged} (${((flagged / Math.max(1, withEntry)) * 100).toFixed(1)}%)`);
console.log(rows.join("\n"));
db.close();
