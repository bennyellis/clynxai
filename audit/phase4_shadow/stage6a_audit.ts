// Phase 4 stage 6a - READ-ONLY contamination audit of a COPY of a database. It applies NOTHING: it works on a scratch copy of the copy, refuses the app's own data folders,
// makes no network or AI calls, and writes (1) a private findings file with names and titles, (2) a counts-only summary and (3) a proposed per-product correction plan whose
// every change carries the before-image needed to undo it (see correction_journal.ts for the mechanism that would apply and undo a plan, tested on scratch copies only).
//   node audit/phase4_shadow/build.cjs stage6a_audit && node audit/phase4_shadow/stage6a_audit.cjs <copy-of-scout.db> <scratch-folder> <output-folder>
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EvidenceDoc } from "../../src/main/identity/credibility.ts";
import { buildContext, compareProducts, resolveListing, type ListingResolution, type ProductVerdict } from "../../src/main/identity/foundationResolver.ts";
import { Store } from "../../src/main/store.ts";

const source = path.resolve(process.argv[2] ?? "C:/Users/biggt/ClynxDbCopy/scout.db");
const scratch = path.resolve(process.argv[3] ?? "C:/Users/biggt/ClynxStage6aScratch");
const outDir = path.resolve(process.argv[4] ?? "C:/Users/biggt/ClynxShadowOutput_stage6a");
if (/fb-marketplace-scout[\\/]+data[\\/]/i.test(source) || /AppData[\\/]+Roaming[\\/]+(Clynx|marketplace-scout)/i.test(source)) {
  console.error("Refusing to run: this looks like the app's own data folder. Give it a COPY of scout.db in another folder.");
  process.exit(2);
}
let fetchAttempts = 0;
globalThis.fetch = (() => {
  fetchAttempts++;
  throw new Error("network is blocked in shadow mode");
}) as typeof fetch;
const sha = (f: string) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");

type Conf = "high" | "medium" | "low";
interface Finding {
  kind: "contaminated" | "generic-holds-specific" | "filed-under-broader" | "merged" | "duplicate" | "possible-duplicate" | "valuation" | "alias" | "relation" | "needs-evidence";
  productId: string;
  product: string;
  confidence: Conf;
  summary: string;
  evidence: string[];
  related?: Array<{ id: string; name: string }>;
}
interface Proposal {
  id: string;
  productId: string;
  product: string;
  action: "move-listing" | "move-photo" | "review-merge" | "clear-valuation" | "reject-alias-candidate" | "reject-relation-candidate" | "gather-evidence" | "create-entry";
  confidence: Conf;
  why: string;
  // The exact change, never applied here: table, key, the columns and the value they would get.
  change: { table: string; key: Record<string, string>; set: Record<string, unknown> } | null;
  // The row(s) as they are now: restoring these undoes the change completely.
  before: Record<string, unknown> | null;
  requiresReview: true;
}

const confOf = (r: { sureness: string }): Conf => (r.sureness === "high" ? "high" : r.sureness === "medium" ? "medium" : "low");

async function main() {
  fs.mkdirSync(scratch, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  const hashBefore = sha(source);
  const work = path.join(scratch, "scout.db");
  fs.copyFileSync(source, work);

  // Stage 3a candidate relations and aliases exist only in the scratch copy, built the same way the stage 3b run builds them.
  const store = new Store(work, { identityFoundation: true });
  while (!store.identity!.backfillStep(20).done) {
    /* drain */
  }
  store.close();

  const db = new DatabaseSync(work, { readOnly: true });
  type P = { id: string; name: string; category: string | null; family: string | null; parent: string | null; sold: number | null; soldN: number | null; est: number | null; basis: string | null; activeMed: number | null; created: number | null };
  const prods = (db.prepare("SELECT id, name, category, family, parent_product_id AS parent, ebay_avg_sold_price_usd AS sold, ebay_comps_sample_size AS soldN, ebay_est_value_usd AS est, ebay_est_basis AS basis, ebay_active_median_usd AS activeMed, created_at AS created FROM products").all() as unknown) as P[];
  const listings = db.prepare("SELECT id, title, product_id, seller_name, reference_price_usd FROM listings").all() as Array<{ id: string; title: string; product_id: string | null; seller_name: string | null; reference_price_usd: number | null }>;
  const photos = db.prepare("SELECT id, product_id, source_title FROM product_images").all() as Array<{ id: string; product_id: string; source_title: string | null }>;
  const relations = db.prepare("SELECT id, from_product_id, to_product_id, relation, status, confidence FROM product_relations").all() as Array<{ id: string; from_product_id: string; to_product_id: string; relation: string; status: string; confidence: number }>;
  const aliases = db.prepare("SELECT id, alias_text, product_id, status, source, confidence FROM product_aliases").all() as Array<{ id: string; alias_text: string; product_id: string; status: string; source: string; confidence: number }>;
  db.close();

  const byId = new Map(prods.map((p) => [p.id, p]));
  const docs: EvidenceDoc[] = [
    ...listings.map((l) => ({ text: l.title, origin: l.seller_name ? `seller:${l.seller_name.toLowerCase()}` : `title:${l.title.toLowerCase()}`, kind: "listing" as const })),
    ...photos.filter((i) => i.source_title).map((i) => ({ text: i.source_title as string, origin: `title:${(i.source_title as string).toLowerCase()}`, kind: "photo" as const })),
  ];
  const entries = prods.map((p) => ({ id: p.id, name: p.name }));
  const ctx = buildContext(entries, docs);
  const info = (id: string) => ctx.info(id)!;

  const cache = new Map<string, ListingResolution>();
  const resolve = (title: string, seller?: string | null): ListingResolution => {
    const k = title.toLowerCase();
    let r = cache.get(k);
    if (!r) {
      r = resolveListing(title, entries, ctx, { seller });
      cache.set(k, r);
    }
    return r;
  };

  const findings: Finding[] = [];
  const proposals: Proposal[] = [];
  let seq = 0;
  const propose = (p: Omit<Proposal, "id" | "requiresReview">) => proposals.push({ id: `p${String(++seq).padStart(4, "0")}`, requiresReview: true, ...p });

  // --- every product's filed listings and photos, resolved against ALL entries
  type Doc = { kind: "listing" | "photo"; id: string; title: string; res: ListingResolution; seller?: string | null };
  const filed = new Map<string, Doc[]>();
  for (const l of listings) if (l.product_id) (filed.get(l.product_id) ?? filed.set(l.product_id, []).get(l.product_id)!).push({ kind: "listing", id: l.id, title: l.title, res: resolve(l.title, l.seller_name), seller: l.seller_name });
  for (const i of photos) if (i.source_title) (filed.get(i.product_id) ?? filed.set(i.product_id, []).get(i.product_id)!).push({ kind: "photo", id: i.id, title: i.source_title, res: resolve(i.source_title) });

  const stats = { productsWithEvidence: filed.size, listingsFiled: 0, photosWithTitle: 0, docsSupporting: 0, docsPointElsewhere: 0, docsFamilyOnly: 0, docsUncertain: 0, docsOther: 0 };
  for (const [pid, ds] of filed) {
    const p = byId.get(pid);
    if (!p) continue;
    const pi = info(pid);
    const elsewhere: Array<{ d: Doc; target: { id: string; name: string }; v: ProductVerdict }> = [];
    const specifics: Array<{ d: Doc; target: { id: string; name: string } }> = [];
    let supporting = 0;
    for (const d of ds) {
      if (d.kind === "listing") stats.listingsFiled++;
      else stats.photosWithTitle++;
      const r = d.res;
      if (r.verdict === "confirmed" && r.product?.id === pid) {
        stats.docsSupporting++;
        supporting++;
      } else if (r.verdict === "confirmed" && r.product && r.product.id !== pid) {
        const v = compareProducts(pi, info(r.product.id), ctx);
        if (v.verdict === "confirmed") {
          stats.docsOther++; // it points at an entry that is the same product as this one: a duplicate entry, not contamination
          continue;
        }
        if (v.verdict === "related" && v.relation !== "goes-with" && v.moreSpecific === "b") {
          // the title resolves to a MORE specific entry (a variant, bundle, edition or member) than the one it is filed under
          specifics.push({ d, target: r.product });
          stats.docsPointElsewhere++;
          continue;
        }
        if (v.verdict === "related" && v.relation !== "goes-with" && v.moreSpecific === "a") {
          // the title is LESS specific than the entry it is filed under: it cannot show the entry's variant
          stats.docsUncertain++;
          continue;
        }
        stats.docsPointElsewhere++;
        elsewhere.push({ d, target: r.product, v });
      } else if (r.verdict === "related" && r.product?.id === pid && (r.relation === "family" || r.relation === "variant")) {
        stats.docsFamilyOnly++;
        specifics.push({ d, target: { id: "", name: r.newModel?.note ?? "no specific entry" } });
      } else if (r.verdict === "uncertain" || r.verdict === "related") {
        stats.docsUncertain++;
      } else stats.docsOther++;
    }

    // F1: filed material that is confidently a different product
    const real = elsewhere.filter((e) => e.v.verdict === "different" || e.v.verdict === "related");
    if (real.length) {
      const confidence: Conf = real.some((e) => e.d.res.sureness === "high") && supporting === 0 ? "high" : real.some((e) => e.d.res.sureness !== "low") ? "medium" : "low";
      const distinctTargets = new Set(real.map((e) => e.target.id));
      findings.push({
        kind: distinctTargets.size >= 2 || (supporting > 0 && real.length > 0) ? "merged" : "contaminated", productId: pid, product: p.name, confidence,
        summary: `${real.length} of ${ds.length} filed items are confidently a different product${supporting ? ` (${supporting} support this entry)` : " (none support this entry)"}`,
        evidence: real.slice(0, 8).map((e) => `${e.d.kind} "${e.d.title.slice(0, 80)}" -> ${e.target.name} (${e.v.verdict}${e.v.relation ? "/" + e.v.relation : ""})`),
        related: [...new Map(real.map((e) => [e.target.id, e.target])).values()].slice(0, 5),
      });
      for (const e of real) {
        const c = confOf(e.d.res);
        propose({
          productId: pid, product: p.name, action: e.d.kind === "listing" ? "move-listing" : "move-photo", confidence: c === "high" && supporting === 0 ? "high" : "medium",
          why: `"${e.d.title.slice(0, 80)}" resolves to "${e.target.name}", not "${p.name}"`,
          change: { table: e.d.kind === "listing" ? "listings" : "product_images", key: { id: e.d.id }, set: { product_id: e.target.id } },
          before: { product_id: pid },
        });
      }
    }
    // F2: a family-level entry holding items that name something more specific
    if (specifics.length) {
      findings.push({
        kind: pi.generic || pi.words.size <= 1 ? "generic-holds-specific" : "filed-under-broader", productId: pid, product: p.name, confidence: specifics.some((s) => s.target.id) ? "high" : "medium",
        summary: `${pi.generic || pi.words.size <= 1 ? "family-level entry" : "entry"} with ${specifics.length} filed item(s) that name something more specific`,
        evidence: specifics.slice(0, 8).map((s) => `${s.d.kind} "${s.d.title.slice(0, 80)}" -> ${s.target.name || "(no entry)"}`),
        related: specifics.filter((s) => s.target.id).slice(0, 5).map((s) => s.target),
      });
      for (const s of specifics.filter((x) => x.target.id)) {
        propose({
          productId: pid, product: p.name, action: s.d.kind === "listing" ? "move-listing" : "move-photo", confidence: "medium",
          why: `"${s.d.title.slice(0, 80)}" is the more specific "${s.target.name}", filed under the family-level "${p.name}"`,
          change: { table: s.d.kind === "listing" ? "listings" : "product_images", key: { id: s.d.id }, set: { product_id: s.target.id } }, before: { product_id: pid },
        });
      }
    }
    // F7: material is filed but none of it supports the entry
    if (ds.length > 0 && supporting === 0 && real.length === 0 && !specifics.length) {
      findings.push({ kind: "needs-evidence", productId: pid, product: p.name, confidence: "low", summary: `${ds.length} filed item(s), none states what the entry states`, evidence: ds.slice(0, 5).map((d) => `${d.kind} "${d.title.slice(0, 80)}" -> ${d.res.verdict}`) });
    }
  }

  // --- F4 duplicates (exhaustive over all pairs)
  const pairVerdicts = new Map<string, ProductVerdict>();
  const dupPairs: Array<{ a: P; b: P; v: ProductVerdict }> = [];
  for (let i = 0; i < prods.length; i++) {
    for (let j = i + 1; j < prods.length; j++) {
      const v = compareProducts(info(prods[i].id), info(prods[j].id), ctx);
      if (v.verdict === "confirmed" || (v.verdict === "uncertain" && v.lean === "same")) {
        pairVerdicts.set(`${prods[i].id}|${prods[j].id}`, v);
        dupPairs.push({ a: prods[i], b: prods[j], v });
      }
    }
  }
  for (const d of dupPairs) {
    const sameCategory = d.a.category === d.b.category;
    findings.push({
      kind: d.v.verdict === "confirmed" ? "duplicate" : "possible-duplicate", productId: d.a.id, product: d.a.name, confidence: d.v.verdict === "confirmed" ? (sameCategory ? "high" : "medium") : "low",
      summary: `"${d.a.name}" and "${d.b.name}" read as the same product (${d.v.reasons[0] ?? ""})${sameCategory ? "" : "; categories differ"}`,
      evidence: [d.v.reasons.join("; ")], related: [{ id: d.b.id, name: d.b.name }],
    });
    if (d.v.verdict === "confirmed") {
      propose({ productId: d.a.id, product: d.a.name, action: "review-merge", confidence: sameCategory ? "high" : "medium", why: `"${d.b.name}" reads as the same product as "${d.a.name}": a person decides which name to keep; nothing is merged automatically`, change: null, before: null });
    }
  }

  // --- F5 valuations
  const valued = prods.filter((p) => p.sold != null || p.est != null);
  const valueOf = (p: P) => p.est ?? p.sold ?? null;
  for (const p of valued) {
    const pi = info(p.id);
    const val = valueOf(p)!;
    const flags: string[] = [];
    let conf: Conf = "low";
    if (pi.generic || pi.words.size <= 1) {
      flags.push(`a value ($${val.toFixed(0)}) is held on a family-level entry`);
      conf = "medium";
    }
    if ((p.soldN ?? 0) <= 1 && p.est == null) flags.push(`the average rests on ${p.soldN ?? 0} comparable sale(s)`);
    const dup = dupPairs.find((d) => (d.a.id === p.id || d.b.id === p.id) && d.v.verdict === "confirmed");
    if (dup) {
      const other = dup.a.id === p.id ? dup.b : dup.a;
      const ov = valueOf(other);
      if (ov != null && Math.abs(ov - val) / Math.max(ov, val) >= 0.3) {
        flags.push(`the same product under "${other.name}" is valued $${ov.toFixed(0)} (this one $${val.toFixed(0)})`);
        conf = "high";
      }
    }
    const contaminated = findings.find((f) => (f.kind === "contaminated" || f.kind === "merged") && f.productId === p.id);
    if (contaminated) {
      flags.push("its filed material includes other products, so comparable sales found for it may mix products");
      conf = conf === "high" ? "high" : "medium";
    }
    // far from its own sibling variants
    const sibVals = prods
      .filter((q) => q.id !== p.id && valueOf(q) != null && (q.soldN ?? 0) >= 3)
      .filter((q) => {
        const v = compareProducts(pi, info(q.id), ctx);
        return v.verdict === "related" && v.relation === "variant";
      });
    if (sibVals.length && (p.soldN ?? 0) <= 2) {
      const med = sibVals.map((q) => valueOf(q)!).sort((x, y) => x - y)[Math.floor(sibVals.length / 2)];
      if (val > med * 3 || val < med / 3) flags.push(`its value is more than 3x away from its variants' median ($${med.toFixed(0)}) on a sample of ${p.soldN ?? 0}`);
    }
    if (flags.length) {
      findings.push({ kind: "valuation", productId: p.id, product: p.name, confidence: conf, summary: flags[0], evidence: flags });
      if (conf !== "low") {
        propose({ productId: p.id, product: p.name, action: "clear-valuation", confidence: conf, why: flags.join("; "),
          change: { table: "products", key: { id: p.id }, set: { ebay_avg_sold_price_usd: null, ebay_comps_sample_size: null, ebay_est_value_usd: null, ebay_est_basis: null } },
          before: { ebay_avg_sold_price_usd: p.sold, ebay_comps_sample_size: p.soldN, ebay_est_value_usd: p.est, ebay_est_basis: p.basis } });
      }
    }
  }

  // --- F6 alias and relation candidates written by stage 3a, checked against the new resolver
  let aliasChecked = 0;
  let aliasBad = 0;
  for (const a of aliases) {
    aliasChecked++;
    const target = byId.get(a.product_id);
    if (!target) continue;
    const r = resolve(a.alias_text);
    const wrong = (r.verdict === "confirmed" && r.product && r.product.id !== a.product_id && compareProducts(info(a.product_id), info(r.product.id), ctx).verdict !== "confirmed") || (r.verdict === "related" && r.relation === "goes-with");
    if (wrong) {
      aliasBad++;
      findings.push({ kind: "alias", productId: a.product_id, product: target.name, confidence: confOf(r), summary: `alias candidate "${a.alias_text}" resolves to ${r.verdict === "related" ? `an item that goes with "${r.product?.name}"` : `"${r.product?.name}"`}, not "${target.name}"`, evidence: [r.reasons.join("; ")] });
      propose({ productId: a.product_id, product: target.name, action: "reject-alias-candidate", confidence: confOf(r), why: `alias candidate "${a.alias_text}" does not stand for "${target.name}" (${r.reasons[0] ?? ""})`,
        change: { table: "product_aliases", key: { alias_text: a.alias_text, product_id: a.product_id }, set: { status: "rejected" } }, before: { status: a.status } });
    }
  }
  let relChecked = 0;
  let relBad = 0;
  for (const r of relations) {
    relChecked++;
    const f = byId.get(r.from_product_id);
    const t = byId.get(r.to_product_id);
    if (!f || !t) continue;
    const v = compareProducts(info(f.id), info(t.id), ctx);
    const conflicts = (r.relation === "same-as" && (v.verdict === "different" || (v.verdict === "related" && v.relation !== "alias"))) || (r.relation === "narrower-than" && v.verdict === "confirmed");
    if (conflicts) {
      relBad++;
      findings.push({ kind: "relation", productId: f.id, product: f.name, confidence: v.verdict === "confirmed" || v.verdict === "different" ? "high" : "medium", summary: `candidate relation "${r.relation}" to "${t.name}" disagrees with the resolver (${v.verdict}${v.relation ? "/" + v.relation : ""})`, evidence: [v.reasons.join("; ")], related: [{ id: t.id, name: t.name }] });
      propose({ productId: f.id, product: f.name, action: "reject-relation-candidate", confidence: "medium", why: `"${f.name}" ${r.relation} "${t.name}" is contradicted by the current read (${v.verdict}${v.relation ? "/" + v.relation : ""})`,
        change: { table: "product_relations", key: { from_product_id: r.from_product_id, to_product_id: r.to_product_id, relation: r.relation }, set: { status: "rejected" } }, before: { status: r.status } });
    }
  }

  // --- F7 entries with nothing behind them
  const withEvidence = new Set(filed.keys());
  const needsEvidence = prods.filter((p) => !withEvidence.has(p.id));
  for (const p of needsEvidence) {
    const pi = info(p.id);
    const weak = pi.words.size <= 1 || (pi.generic && !pi.host);
    if (weak) {
      findings.push({ kind: "needs-evidence", productId: p.id, product: p.name, confidence: "low", summary: pi.words.size <= 1 ? "a one-word entry with no filed listing or photo title" : "a family-level entry with no filed listing or photo title", evidence: [] });
      propose({ productId: p.id, product: p.name, action: "gather-evidence", confidence: "low", why: "nothing filed under this entry shows what it stands for", change: null, before: null });
    }
  }

  // --- outputs
  const byKind: Record<string, { findings: number; products: number; high: number; medium: number; low: number }> = {};
  for (const f of findings) {
    const k = (byKind[f.kind] ??= { findings: 0, products: 0, high: 0, medium: 0, low: 0 });
    k.findings++;
    k[f.confidence]++;
  }
  for (const kind of Object.keys(byKind)) byKind[kind].products = new Set(findings.filter((f) => f.kind === kind).map((f) => f.productId)).size;
  const flaggedProducts = (conf?: Conf) => new Set(findings.filter((f) => !conf || f.confidence === conf).map((f) => f.productId)).size;
  // "core" = something that can put a wrong product or a wrong number in front of a decision; the rest is informational (a photo for a 512GB console filed under the
  // plain console entry, an entry with nothing filed under it)
  const coreKinds = new Set(["contaminated", "merged", "generic-holds-specific", "duplicate", "alias", "relation"]);
  const isCore = (f: Finding) => coreKinds.has(f.kind) || (f.kind === "valuation" && f.confidence !== "low");
  const contaminatedProducts = new Set(findings.filter(isCore).map((f) => f.productId));
  const differentProductMaterial = new Set(findings.filter((f) => f.kind === "contaminated" || f.kind === "merged").map((f) => f.productId));
  const informationalOnly = new Set(findings.filter((f) => !isCore(f)).map((f) => f.productId).filter((id) => !contaminatedProducts.has(id)));
  const proposalCounts: Record<string, number> = {};
  for (const p of proposals) proposalCounts[p.action] = (proposalCounts[p.action] ?? 0) + 1;
  const jsonl = (f: string, r: unknown[]) => fs.writeFileSync(path.join(outDir, f), r.map((x) => JSON.stringify(x)).join("\n") + "\n");
  jsonl("findings.jsonl", findings);
  fs.writeFileSync(path.join(outDir, "correction_plan.json"), JSON.stringify({ note: "PROPOSED ONLY. Nothing here has been applied. Every item needs a person's decision. 'before' is the exact prior value; restoring it undoes the item.", proposals }, null, 1));
  const summary = {
    database: { source, sha256Before: hashBefore, sha256After: sha(source), unchanged: hashBefore === sha(source) },
    counts: { products: prods.length, listings: listings.length, listingsFiled: stats.listingsFiled, photosWithTitle: stats.photosWithTitle, productsWithFiledEvidence: stats.productsWithEvidence },
    filedItems: { supportEntry: stats.docsSupporting, confidentlyElsewhere: stats.docsPointElsewhere, familyOrVariantOnly: stats.docsFamilyOnly, uncertain: stats.docsUncertain, other: stats.docsOther },
    findingsByKind: byKind,
    productsFlagged: { any: flaggedProducts(), high: flaggedProducts("high"), medium: flaggedProducts("medium"), core: contaminatedProducts.size, withDifferentProductMaterialFiled: differentProductMaterial.size, informationalOnly: informationalOnly.size, ofTotal: prods.length },
    candidatesChecked: { aliases: aliasChecked, aliasesDisputed: aliasBad, relations: relChecked, relationsDisputed: relBad },
    proposals: { total: proposals.length, byAction: proposalCounts, byConfidence: { high: proposals.filter((p) => p.confidence === "high").length, medium: proposals.filter((p) => p.confidence === "medium").length, low: proposals.filter((p) => p.confidence === "low").length } },
    costs: { aiCalls: 0, networkAttempts: fetchAttempts, comparableSaleLookups: 0 },
  };
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(JSON.stringify(summary, null, 1));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
