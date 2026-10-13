// Phase 4 stage 3a: the additive identity foundation. Pure builders, the tables and the backfill on throw-away databases, decisions and their reversal,
// indexed candidate retrieval, and the guarantees that nothing existing is touched. Categories are mixed on purpose.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { aliasCandidatesFor, buildProductIdentity, classifyRelation, identityTermsOf, referenceRole, splitHost } from "../identity/foundation.js";
import { IDENTITY_TABLES } from "../identity/foundationStore.js";
import { aliasCovered } from "../identity/codes.js";
import { Store } from "../store.js";
import { check, run, section } from "./_testkit.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-idfound-"));
let n = 0;
const newPath = () => path.join(dir, `db${++n}.db`);

// Seed through plain SQL so the test does not depend on any Store method that could itself change.
const NAMES: Array<[string, string, string]> = [
  ["p01", "Xbox Wireless Controller", "Games"], ["p02", "Xbox 360 Wireless Controller", "Games"], ["p03", "Xbox Series S", "Games"], ["p04", "Power cable for Xbox Series S", "Games"],
  ["p05", "Nintendo 3DS", "Games"], ["p06", "Pokémon Y (Nintendo 3DS)", "Games"], ["p07", "PlayStation 5 Slim", "Games"], ["p08", "PS5 Slim", "Games"],
  ["p09", "Samsung Galaxy S21", "Phones"], ["p10", "Samsung Galaxy S21 Ultra", "Phones"], ["p11", "DeWalt DCD791 20V Drill", "Tools"], ["p12", "DeWalt DCD771 20V Drill", "Tools"],
  ["p13", "Replacement blade for Dyson V8", "Home"], ["p14", "Dyson V8", "Home"], ["p15", "Fender Stratocaster", "Instruments"], ["p16", "Fender Stratocaster 0114012", "Instruments"],
  ["p17", "KitchenAid Stand Mixer", "Home"], ["p18", "Milwaukee M18 Battery", "Tools"], ["p19", "Milwaukee M12 Battery", "Tools"], ["p20", "Canon EOS R5 Body", "Cameras"],
];

function seed(file: string): void {
  const store = new Store(file); // creates the app's own tables exactly as today
  store.close();
  const db = new DatabaseSync(file);
  db.exec("BEGIN");
  const insP = db.prepare("INSERT INTO products (id, name, category, created_at, image_url) VALUES (?, ?, ?, ?, ?)");
  NAMES.forEach(([id, name, cat], i) => insP.run(id, name, cat, 1_700_000_000_000 + i, "data:image/jpeg;base64," + "A".repeat(2000)));
  const insI = db.prepare("INSERT INTO product_images (id, product_id, image_data, source_title, created_at) VALUES (?, ?, ?, ?, ?)");
  insI.run("i1", "p07", "data:x", "Playstation 5 PS5 Slim console bundle", 1);
  insI.run("i2", "p07", "data:x", "PS5 slim digital 1TB", 1);
  insI.run("i3", "p01", "data:x", "Microsoft Xbox 360 wireless controller 1403", 1);
  const insL = db.prepare("INSERT INTO listings (id, title, url, first_seen_at, source, seller_name, product_id) VALUES (?, ?, ?, ?, 'facebook', ?, ?)");
  insL.run("L1", "Xbox Series S 512GB Console O1766", "https://x/1", 1, "s1", "p03");
  insL.run("L2", "Used PS5 slim with controller", "https://x/2", 2, "s2", "p07");
  insL.run("L3", "DeWalt DCD791 20V drill bare tool", "https://x/3", 3, "s3", null);
  insL.run("L4", "Vintage lamp", "https://x/4", 4, "s4", null);
  db.exec("COMMIT");
  db.close();
}

// A checksum of every row of every NON-identity table, so "nothing existing changed" is proved by content, not by counts.
function checksums(file: string): Record<string, string> {
  const db = new DatabaseSync(file, { readOnly: true });
  const out: Record<string, string> = {};
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name).filter((t) => !(IDENTITY_TABLES as readonly string[]).includes(t));
  for (const t of tables) {
    const h = createHash("sha256");
    let last = -1;
    for (;;) {
      const rows = db.prepare(`SELECT rowid AS _r, * FROM "${t}" WHERE rowid > ? ORDER BY rowid LIMIT 200`).all(last) as Array<Record<string, unknown>>;
      if (!rows.length) break;
      for (const r of rows) h.update(JSON.stringify(r));
      last = rows[rows.length - 1]._r as number;
    }
    out[t] = h.digest("hex");
  }
  db.close();
  return out;
}
const tableNames = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
  db.close();
  return names;
};
function drain(store: Store, maxSteps = 5000, budgetMs = 5): number {
  let steps = 0;
  while (steps++ < maxSteps) if (store.identity!.backfillStep(budgetMs).done) break;
  return steps;
}
const raw = (file: string) => new DatabaseSync(file, { readOnly: true });

run(() => {
  section("pure builders: category-free attributes with provenance");
  {
    check("a name with a model code is 'exact' level with the code as a likely-defining attribute", (() => {
      const r = buildProductIdentity({ productId: "a", name: "DeWalt DCD791 20V Drill" });
      return r.level === "exact" && r.attributes.some((a) => a.kind === "code" && a.value === "dcd791" && a.weight === "likely-defining") && r.identityKey !== null;
    })());
    check("a name with only words is 'line' and says what is unresolved", (() => {
      const r = buildProductIdentity({ productId: "a", name: "Xbox Wireless Controller" });
      return r.level === "line" && r.unresolved.length > 0 && r.confidence < 0.6;
    })());
    check("every attribute carries its source", buildProductIdentity({ productId: "a", name: "Canon EOS R5 Body" }).attributes.every((a) => a.source === "name" && a.confidence > 0 && a.confidence <= 1));
    check("a corroborated code has higher confidence", (() => {
      const plain = buildProductIdentity({ productId: "a", name: "Canon EOS R5 Body" });
      const proven = buildProductIdentity({ productId: "a", name: "Canon EOS R5 Body", corroborated: [{ code: "r5", reason: "seen-in-multiple-sources" }] });
      return proven.confidence > plain.confidence && proven.attributes.find((a) => a.value === "r5")!.confidence > plain.attributes.find((a) => a.value === "r5")!.confidence;
    })());
    check("the same name always gives the same key, and a different model a different one", buildProductIdentity({ productId: "x", name: "Milwaukee M18 Battery" }).identityKey === buildProductIdentity({ productId: "y", name: "battery milwaukee M18" }).identityKey && buildProductIdentity({ productId: "x", name: "Milwaukee M18 Battery" }).identityKey !== buildProductIdentity({ productId: "x", name: "Milwaukee M12 Battery" }).identityKey);
    check("the bracketed host is kept apart from the product's own identity", (() => {
      const { subject, host } = splitHost("Pokémon Y (Nintendo 3DS)");
      const r = buildProductIdentity({ productId: "a", name: "Pokémon Y (Nintendo 3DS)" });
      return subject === "Pokémon Y" && host === "Nintendo 3DS" && r.attributes.some((a) => a.kind === "host") && !r.attributes.some((a) => a.kind === "word" && a.value === "nintendo");
    })());
    check("terms for the candidate index", identityTermsOf("Pokémon Y (Nintendo 3DS)").some((t) => t.term === "nintendo") && identityTermsOf("Milwaukee M18 Battery").some((t) => t.kind === "code" && t.term === "m18"));
  }

  section("relations: a product that references another is not that product");
  {
    const rel = (a: string, b: string) => classifyRelation({ id: "a1", name: a }, { id: "b1", name: b });
    check("a game naming its platform in brackets REFERENCES it", (() => { const r = rel("Pokémon Y (Nintendo 3DS)", "Nintendo 3DS"); return r?.relation === "references" && r.role === "for" && r.fromProductId === "a1" && r.toProductId === "b1"; })());
    check("'for' / 'with' wording references too", rel("Power cable for Xbox Series S", "Xbox Series S")?.relation === "references" && rel("Replacement blade for Dyson V8", "Dyson V8")?.role === "for" && rel("Camera bundle with Canon EOS R5 Body", "Canon EOS R5 Body")?.role === "with");
    check("a plainly narrower name is 'narrower-than' with its ambiguity attached (could be an accessory, component or bundle)", (() => { const r = rel("Samsung Galaxy S21 Ultra", "Samsung Galaxy S21"); return r?.relation === "narrower-than" && r.ambiguity.join(" ").includes("accessory"); })());
    check("different models have no relation", rel("DeWalt DCD791 20V Drill", "DeWalt DCD771 20V Drill") === null && rel("Milwaukee M18 Battery", "Milwaukee M12 Battery") === null);
    check("the same wording is a low-confidence 'same-as' candidate, a short form even lower", (() => { const e = rel("Fender Stratocaster", "Stratocaster Fender"); const s = rel("PS5 Slim", "PlayStation 5 Slim"); return e?.relation === "same-as" && s?.relation === "same-as" && s.confidence < e.confidence; })());
    check("an accessory or game is never reported as the same as its host", rel("Power cable for Xbox Series S", "Xbox Series S")?.relation !== "same-as" && rel("Pokémon Y (Nintendo 3DS)", "Nintendo 3DS")?.relation !== "same-as");
    check("referenceRole is null for ordinary descriptive names", referenceRole("Samsung Galaxy S21 Ultra", "Samsung Galaxy S21") === null);
    const al = aliasCandidatesFor({ name: "PlayStation 5 Slim", titles: ["Playstation 5 PS5 Slim", "PS5 slim digital", "Slim console"], isCovered: aliasCovered });
    check("a short form found in filed titles is a candidate alias with its support", al.length === 1 && al[0].alias === "ps5" && al[0].support === 2);
  }

  section("held-out categories: expectations written from the design, never tuned to the output");
  {
    const rel = (a: string, b: string) => classifyRelation({ id: "a1", name: a }, { id: "b1", name: b });
    const cases: Array<[string, string, string | null, string]> = [
      ["Trek Domane SL5", "Trek Domane", "narrower-than", "bike model tier"],
      ["Cover for Weber Genesis II Grill", "Weber Genesis II Grill", "references", "grill accessory"],
      ["Bosch 18V Drill Driver Kit with 2 batteries", "Bosch 18V Drill Driver", "narrower-than", "a kit that includes the tool plus extras: a bundle, flagged ambiguous"],
      ["Fender Stratocaster American Professional II", "Fender Stratocaster", "narrower-than", "guitar series"],
      ["Garmin Forerunner 245 Music", "Garmin Forerunner 245", "narrower-than", "watch variant"],
      ["Yamaha P-125 Digital Piano Stand", "Yamaha P-125 Digital Piano", "narrower-than", "accessory that is not a version (stays ambiguous)"],
      ["Lodge 10.25 inch Cast Iron Skillet", "Lodge 12 inch Cast Iron Skillet", null, "size"],
      ["IKEA Kallax 4x4 Shelf", "IKEA Kallax 2x2 Shelf", null, "furniture dimensions"],
      ["Pokemon Charizard 1st Edition Shadowless", "Pokemon Charizard Base Set", null, "collectible edition"],
      ["Carhartt Detroit Jacket Size L", "Carhartt Detroit Jacket Size XL", null, "clothing size"],
      ["Sennheiser HD 650 Headphones", "Sennheiser HD 600 Headphones", null, "audio model"],
      ["Nikon D850 Body", "Nikon D750 Body", null, "camera model"],
      ["Specialized Rockhopper 29", "Specialized Rockhopper", "narrower-than", "wheel size"],
      ["Le Creuset Dutch Oven 5.5 qt", "Le Creuset Dutch Oven 7.25 qt", null, "cookware capacity"],
    ];
    for (const [a, b, want, label] of cases) {
      const r = rel(a, b);
      check(`${label}: ${a} | ${b} -> ${want ?? "no relation"}`, (r?.relation ?? null) === want, r);
    }
    check("the kit's ambiguity names the bundle reading", (rel("Bosch 18V Drill Driver Kit with 2 batteries", "Bosch 18V Drill Driver")?.ambiguity ?? []).join(" ").includes("bundle"));
    check("an accessory that merely contains the product's words stays flagged ambiguous (never a confirmed parent/child)", (rel("Yamaha P-125 Digital Piano Stand", "Yamaha P-125 Digital Piano")?.ambiguity ?? []).join(" ").includes("accessory"));
    check("nothing in the held-out set is ever 'same-as' except identical wording", cases.every(([a, b]) => rel(a, b)?.relation !== "same-as"));
    const lv = (name: string) => buildProductIdentity({ productId: "x", name }).level;
    check("a name with a model number is 'exact', a descriptive one is 'line'", lv("Nikon D850 Body") === "exact" && lv("Weber Genesis II Grill") === "line" && lv("Lodge 12 inch Cast Iron Skillet") === "exact" && lv("iPhone 12") === "exact" && lv("Vintage") === "unknown");
  }

  section("flag off: nothing is created, nothing changes");
  {
    const f = newPath();
    seed(f);
    const before = checksums(f);
    const store = new Store(f); // the default: foundation off
    check("no identity handle", store.identity === null);
    store.close();
    check("no identity table exists", tableNames(f).every((t) => !(IDENTITY_TABLES as readonly string[]).includes(t)), tableNames(f));
    check("every existing table has identical content", JSON.stringify(checksums(f)) === JSON.stringify(before));
  }

  section("flag on: additive schema, repeatable, existing content untouched");
  {
    const f = newPath();
    seed(f);
    const before = checksums(f);
    const beforeCounts = ((): Record<string, number> => { const d = raw(f); const o: Record<string, number> = {}; for (const t of Object.keys(before)) o[t] = Number((d.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n); d.close(); return o; })();
    let store = new Store(f, { identityFoundation: true });
    check("the handle exists and the identity tables were created", store.identity !== null && IDENTITY_TABLES.every((t) => tableNames(f).includes(t)));
    store.close();
    for (let i = 0; i < 3; i++) { store = new Store(f, { identityFoundation: true }); store.close(); }
    check("opening it again and again is harmless (idempotent)", IDENTITY_TABLES.every((t) => tableNames(f).includes(t)));
    check("every pre-existing table has identical content (checksums)", JSON.stringify(checksums(f)) === JSON.stringify(before));
    const d = raw(f);
    check("row counts of every pre-existing table are identical", Object.entries(beforeCounts).every(([t, c]) => Number((d.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n) === c));
    check("the database passes SQLite's own integrity check", (d.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check === "ok");
    d.close();
  }

  section("backfill: complete, resumable, idempotent, and it decides nothing");
  {
    const f = newPath();
    seed(f);
    const before = checksums(f);
    let store = new Store(f, { identityFoundation: true });
    const steps = drain(store, 5000, 0); // a zero budget = one small batch per call
    const s1 = store.identity!.stats();
    check("an identity row and index terms for every product", s1.identities === NAMES.length && s1.terms > NAMES.length * 2, s1);
    check("a listing identity for every listing", s1.listings === 4);
    check("relations were found and ALL are candidates", s1.relations > 5 && s1.relations === s1.relationsCandidate, s1);
    check("aliases were found and ALL are candidates", s1.aliases >= 1 && s1.aliases === s1.aliasesCandidate, s1);
    check("it worked in many small bounded steps, never one long one", steps > 3, steps);
    check("a finished backfill says so and a further call does nothing", store.identity!.backfillStatus().phase === "done" && store.identity!.backfillStep(5).processed === 0);

    // idempotent: wipe the cursor and run the whole thing again
    const relIds = (store.identity!.listRelations() as Array<{ id: string }>).map((r) => r.id).sort().join();
    store.identity!.resetBackfill();
    drain(store);
    const s2 = store.identity!.stats();
    check("running it again changes no counts and no relation ids", JSON.stringify({ ...s2, audit: 0 }) === JSON.stringify({ ...s1, audit: 0 }) && (store.identity!.listRelations() as Array<{ id: string }>).map((r) => r.id).sort().join() === relIds, { s1, s2 });
    store.close();

    // resumable: stop part-way (a "crash" = a new Store on the same file) and finish
    const g = newPath();
    seed(g);
    let a = new Store(g, { identityFoundation: true });
    for (let i = 0; i < 3; i++) a.identity!.backfillStep(1);
    const partial = a.identity!.backfillStatus();
    a.close();
    a = new Store(g, { identityFoundation: true });
    check("it stopped part-way", partial.phase !== "done");
    drain(a);
    check("a restart resumes and reaches exactly the same result", JSON.stringify({ ...a.identity!.stats(), audit: 0 }) === JSON.stringify({ ...s1, audit: 0 }), a.identity!.stats());
    a.close();
    check("nothing pre-existing changed through all of this", JSON.stringify(checksums(f)) === JSON.stringify(before) && JSON.stringify(checksums(g)) === JSON.stringify(before));

    // what it concluded
    store = new Store(f, { identityFoundation: true });
    const rels = store.identity!.listRelations() as Array<{ from_product_id: string; to_product_id: string; relation: string; role: string | null }>;
    const has = (from: string, to: string, relation: string) => rels.some((r) => r.from_product_id === from && r.to_product_id === to && r.relation === relation);
    check("the game and the power cable REFERENCE their hosts", has("p06", "p05", "references") && has("p04", "p03", "references"));
    check("neither the game nor the cable is 'the same as' or 'narrower than' its host", !rels.some((r) => ["p06", "p04"].includes(r.from_product_id) && ["p05", "p03"].includes(r.to_product_id) && r.relation !== "references"));
    check("Ultra is a candidate narrower product of the S21", has("p10", "p09", "narrower-than"));
    check("different drill / battery models are not related", !rels.some((r) => (["p11", "p12"].includes(r.from_product_id) && ["p11", "p12"].includes(r.to_product_id)) || (["p18", "p19"].includes(r.from_product_id) && ["p18", "p19"].includes(r.to_product_id))));
    check("the short-form alias 'ps5' is a candidate for PlayStation 5 Slim", (store.identity!.listAliases() as Array<{ alias_norm: string; product_id: string; status: string }>).some((x) => x.alias_norm === "ps5" && x.product_id === "p07" && x.status === "candidate"));
    const li = raw(f).prepare("SELECT * FROM listing_identity WHERE listing_id = 'L1'").get() as Record<string, unknown>;
    check("a listing keeps the link it already had and records its own best fit beside it", li.stored_product_id === "p03" && li.best_product_id !== null);
    check("the seller code on L1 is recorded as unverified, not as a model", JSON.parse(li.extras_json as string).unverified.some((u: { code: string }) => u.code === "o1766") && JSON.parse(li.extras_json as string).credible.length === 0);
    store.close();
  }

  section("decisions are explicit, recorded and reversible; the backfill never overrides them");
  {
    const f = newPath();
    seed(f);
    const store = new Store(f, { identityFoundation: true });
    drain(store);
    const id = store.identity!;
    const target = (id.listRelations({ relation: "narrower-than" }) as Array<{ id: string }>)[0];
    id.decideRelation(target.id, "confirmed", "tester", "looks right");
    const confirmed = id.listRelations({ status: "confirmed" }) as Array<{ id: string; decided_by: string }>;
    check("a person's decision is recorded with who and why", confirmed.length === 1 && confirmed[0].decided_by === "tester");
    id.resetBackfill();
    drain(store);
    check("a backfill re-run leaves the decision alone", (id.listRelations({ status: "confirmed" }) as unknown[]).length === 1);
    const audit = raw(f).prepare("SELECT id FROM identity_audit WHERE entity = 'relation' AND entity_id = ? ORDER BY id").all(target.id) as Array<{ id: number }>;
    check("the proposal and the decision are both in the audit log", audit.length === 2);
    let refused = false;
    try { id.revertAudit(audit[0].id); } catch { refused = true; }
    check("an older change cannot be reverted while a newer one exists", refused);
    id.revertAudit(audit[1].id);
    check("reverting the decision restores a candidate", (id.listRelations({ status: "confirmed" }) as unknown[]).length === 0 && (id.listRelations() as Array<{ id: string; status: string }>).find((r) => r.id === target.id)?.status === "candidate");
    const latest = raw(f).prepare("SELECT MAX(id) AS m FROM identity_audit WHERE entity_id = ?").get(target.id) as { m: number };
    id.revertAudit(latest.m); // the revert of the decision itself
    id.revertAudit((raw(f).prepare("SELECT MAX(id) AS m FROM identity_audit WHERE entity_id = ?").get(target.id) as { m: number }).m);
    const al = (id.listAliases() as Array<{ id: string }>)[0];
    id.decideAlias(al.id, "rejected", "tester");
    check("an alias is rejected only by an explicit call", (id.listAliases({ status: "rejected" }) as unknown[]).length === 1 && (id.listAliases({ status: "confirmed" }) as unknown[]).length === 0);
    check("exportDecisions returns what was decided", id.exportDecisions().aliases.length === 1);
    store.close();
  }

  section("indexed candidate retrieval");
  {
    const f = newPath();
    seed(f);
    const store = new Store(f, { identityFoundation: true });
    drain(store);
    const c = store.identity!.candidates("Official Microsoft Xbox 360 Wireless Controller 1403", 5);
    check("the 360 controller entry ranks first, the generic one is also found", c[0]?.name === "Xbox 360 Wireless Controller" && c.some((x) => x.name === "Xbox Wireless Controller"), c.map((x) => x.name));
    check("a drill model finds its own model, not the other", store.identity!.candidates("DeWalt DCD791 drill", 3)[0]?.name === "DeWalt DCD791 20V Drill");
    check("nothing similar means no candidates", store.identity!.candidates("Vintage lamp shade", 5).length === 0);
    const plan = (raw(f).prepare("EXPLAIN QUERY PLAN SELECT product_id FROM identity_terms WHERE term = 'xbox' LIMIT 5").all() as Array<{ detail: string }>).map((r) => r.detail).join(" ");
    check("the lookup uses the term index (no table scan)", /idx_identity_terms_term|USING (COVERING )?INDEX|PRIMARY KEY/.test(plan), plan);
    store.close();
  }

  section("deleting a product removes its identity rows; dropping the foundation restores the plain database");
  {
    const f = newPath();
    seed(f);
    const before = checksums(f);
    const store = new Store(f, { identityFoundation: true });
    drain(store);
    store.deleteProduct("p06");
    const d = raw(f);
    check("no identity row, term, alias or relation still points at the deleted product", ["product_identity", "identity_terms", "product_aliases"].every((t) => Number((d.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE product_id = 'p06'`).get() as { n: number }).n) === 0) && Number((d.prepare("SELECT COUNT(*) AS n FROM product_relations WHERE from_product_id = 'p06' OR to_product_id = 'p06'").get() as { n: number }).n) === 0);
    check("the audit log still remembers what was removed", Number((d.prepare("SELECT COUNT(*) AS n FROM identity_audit WHERE action = 'forget'").get() as { n: number }).n) >= 1);
    d.close();
    store.identity!.drop();
    store.close();
    check("dropping removes only the identity tables", tableNames(f).every((t) => !(IDENTITY_TABLES as readonly string[]).includes(t)));
    const after = checksums(f);
    check("everything else is exactly as the app left it (apart from what deleting a product itself touches: the product, its photos and the pending cloud delete)", Object.keys(before).every((t) => ["products", "product_images", "pending_cloud_deletes"].includes(t) || before[t] === after[t]));
    const g = raw(f);
    check("integrity check still passes", (g.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check === "ok");
    g.close();
  }

  section("the code can only write to the identity tables");
  {
    const src = fs.readFileSync(path.join(process.cwd(), "src", "main", "identity", "foundationStore.ts"), "utf8").replace(/\/\/.*$/gm, "");
    const targets = [...src.replace(/DO UPDATE SET/g, "").matchAll(/(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM|DROP TABLE(?: IF EXISTS)?)\s+\$?\{?(\w+)/gi)].map((m) => m[1].toLowerCase());
    const allowed = new Set<string>([...IDENTITY_TABLES, "t", "table"]); // `t` / `table`: loop variables over the identity tables only (checked below)
    check("every write names an identity table", targets.every((t) => allowed.has(t)), targets.filter((t) => !allowed.has(t)));
    check("the only dynamic table names come from fixed identity lists", /for \(const t of IDENTITY_TABLES\)/.test(src) && /\["product_relations", "product_aliases", "identity_terms", "product_identity", "listing_identity"\]/.test(src) && /const table = a\.entity === "relation" \? "product_relations" : a\.entity === "alias" \? "product_aliases" : null/.test(src));
    const importers = fs.readdirSync(path.join(process.cwd(), "src", "main")).filter((f) => f.endsWith(".ts") && /from "\.\/identity\/foundationStore\.js"/.test(fs.readFileSync(path.join(process.cwd(), "src", "main", f), "utf8")));
    check("only the Store opens the foundation", importers.join() === "store.ts", importers);
    const live = ["scrapeEngine.ts", "scorer.ts", "dealGate.ts", "preAlert.ts", "ebayEngine.ts", "watchcount.ts"].filter((f) => /\bidentity\b[^\n]*\.(candidates|listRelations|listAliases|getProductIdentity)\(/.test(fs.readFileSync(path.join(process.cwd(), "src", "main", f), "utf8")));
    check("no live scoring, matching or valuation module reads the new tables", live.length === 0, live);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
