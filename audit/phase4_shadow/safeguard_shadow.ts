// Phase 4 veto-only safeguard - SHADOW MODE validation on a COPY of a database. Runs the safeguard beside the existing matcher and counts what it would have blocked and what
// it would have wrongly rejected, against hand labels. Changes nothing: works on a scratch copy of the copy, refuses the app's own data folders, no network, no AI.
//   node audit/phase4_shadow/build.cjs safeguard_shadow && node audit/phase4_shadow/safeguard_shadow.cjs <copy-of-scout.db> <scratch-folder> <labels-dir> <output-folder>
// <labels-dir> holds labels_pairs.json and labels_listings.json written by the stage 3b review.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EvidenceDoc } from "../../src/main/identity/credibility.ts";
import { IdentitySafeguard } from "../../src/main/identity/safeguardRuntime.ts";
import { isSimilarProductName, sourceTitleText, Store } from "../../src/main/store.ts";

const source = path.resolve(process.argv[2] ?? "C:/Users/biggt/ClynxDbCopy/scout.db");
const scratch = path.resolve(process.argv[3] ?? "C:/Users/biggt/ClynxSafeguardScratch");
const labelsDir = path.resolve(process.argv[4] ?? "C:/Users/biggt/ClynxShadowOutput_stage3b");
const outDir = path.resolve(process.argv[5] ?? "C:/Users/biggt/ClynxShadowOutput_safeguard");
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

type Truth = { kind: "P"; names: string[] } | { kind: "NONE" };
async function main() {
  fs.mkdirSync(scratch, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  const hashBefore = sha(source);
  const work = path.join(scratch, "scout.db");
  fs.copyFileSync(source, work);
  const store = new Store(work);
  const db = new DatabaseSync(work, { readOnly: true });
  const prods = db.prepare("SELECT id, name FROM products").all() as Array<{ id: string; name: string }>;
  const listings = db.prepare("SELECT id, title, matched_item, product_id, seller_name FROM listings").all() as Array<{ id: string; title: string; matched_item: string | null; product_id: string | null; seller_name: string | null }>;
  const photos = db.prepare("SELECT product_id, source_title FROM product_images WHERE source_title IS NOT NULL").all() as Array<{ product_id: string; source_title: string }>;
  db.close();
  const byId = new Map(prods.map((p) => [p.id, p]));
  const docs: EvidenceDoc[] = [
    ...listings.map((l) => ({ text: l.title, origin: l.seller_name ? `seller:${l.seller_name.toLowerCase()}` : `title:${l.title.toLowerCase()}`, kind: "listing" as const })),
    ...photos.map((i) => ({ text: sourceTitleText(i.source_title), origin: `title:${i.source_title.toLowerCase()}`, kind: "photo" as const })),
  ];
  // the same code path the app uses (candidate retrieval, caching), in shadow mode, with every decision kept
  const guard = new IdentitySafeguard({ entries: () => prods, evidenceDocs: () => docs });
  guard.setMode("shadow", null);
  const evaluate = (a: { title: string; matchedName: string | null; entry: { id: string; name: string }; seller?: string | null }) => guard.decide({ ...a, site: "shadow-tool" })!;

  const count = (rows: Array<{ truth: string; decision: string }>) => {
    const c = { incorrectBlocked: 0, incorrectMissed: 0, incorrectUnsure: 0, correctRejected: 0, correctKept: 0, correctUnsure: 0, ambiguous: { veto: 0, allow: 0, unsure: 0 } };
    for (const r of rows) {
      if (r.truth === "U") c.ambiguous[r.decision as "veto" | "allow" | "unsure"]++;
      else if (r.truth === "wrong") {
        if (r.decision === "veto") c.incorrectBlocked++;
        else if (r.decision === "allow") c.incorrectMissed++;
        else c.incorrectUnsure++;
      } else if (r.decision === "veto") c.correctRejected++;
      else if (r.decision === "allow") c.correctKept++;
      else c.correctUnsure++;
    }
    return c;
  };

  // --- A. listings: the live chain is matched_item -> the existing name matcher -> an entry
  const lab = JSON.parse(fs.readFileSync(path.join(labelsDir, "labels_listings.json"), "utf8")) as Array<{ id: string; truth: Truth }>;
  const truthOf = new Map(lab.map((l) => [l.id, l.truth]));
  const lrows: Array<Record<string, unknown>> = [];
  let noMatch = 0;
  for (const l of listings) {
    const product = l.matched_item ? store.findMatchingProduct(l.matched_item) : null;
    if (!product) {
      noMatch++;
      continue;
    }
    const d = evaluate({ title: l.title, matchedName: l.matched_item, entry: { id: product.id, name: product.name }, seller: l.seller_name });
    const t = truthOf.get(l.id);
    const right = t?.kind === "P" && t.names.includes(product.name);
    lrows.push({ id: l.id, title: l.title, matchedItem: l.matched_item, entry: product.name, storedAs: l.product_id ? byId.get(l.product_id)?.name : null, truth: right ? "right" : "wrong", truthNames: t?.kind === "P" ? t.names : [], decision: d.decision, kind: d.kind, reason: d.reason, against: d.against?.name ?? null });
  }
  // --- B. pairs: "this title was matched to that entry". Every labelled pair, both directions.
  const pl = JSON.parse(fs.readFileSync(path.join(labelsDir, "labels_pairs.json"), "utf8")) as Array<{ a: string; b: string; truth: "S" | "N" | "U" }>;
  const idOf = new Map(prods.map((p) => [p.name, p.id]));
  const prow: Array<Record<string, unknown>> = [];
  for (const p of pl) {
    const ia = idOf.get(p.a);
    const ib = idOf.get(p.b);
    if (!ia || !ib) continue;
    const old = isSimilarProductName(p.a, p.b);
    const dirs: Array<[string, string, string]> = [
      [p.a, p.b, ib],
      [p.b, p.a, ia],
    ];
    for (const [title, entryName, entryId] of dirs) {
      const d = evaluate({ title, matchedName: null, entry: { id: entryId, name: entryName } });
      prow.push({ title, entry: entryName, existingMatcherWouldMatch: old, truth: p.truth === "S" ? "right" : p.truth === "N" ? "wrong" : "U", decision: d.decision, kind: d.kind, reason: d.reason });
    }
  }
  // --- C. photos filed under entries (the audit's population): counted only, no labels
  const filed = photos.map((i) => ({ title: sourceTitleText(i.source_title), entry: byId.get(i.product_id)! })).filter((x) => x.entry);
  const fc = { allow: 0, veto: 0, unsure: 0 };
  const frows: Array<Record<string, unknown>> = [];
  for (const f of filed) {
    const d = evaluate({ title: f.title, matchedName: null, entry: f.entry });
    fc[d.decision]++;
    frows.push({ title: f.title, entry: f.entry.name, decision: d.decision, kind: d.kind, reason: d.reason, against: d.against?.name ?? null });
  }

  const old = prow.filter((r) => r.existingMatcherWouldMatch);
  const summary = {
    database: { source, sha256Before: hashBefore, sha256After: sha(source), unchanged: hashBefore === sha(source) },
    listings: { total: listings.length, withAMatchByTheExistingChain: lrows.length, withoutAMatch: noMatch, ...count(lrows as never) },
    pairsAllLabelled: { evaluated: prow.length, ...count(prow as never) },
    pairsTheExistingMatcherWouldMake: { evaluated: old.length, ...count(old as never) },
    photoTitlesFiledUnderEntries: { evaluated: filed.length, ...fc },
    safeguardStats: { ...guard.stats, totalMs: Math.round(guard.stats.totalMs), contextBuildMs: Math.round(guard.stats.contextBuildMs) },
    costs: { aiCalls: 0, networkAttempts: fetchAttempts },
  };
  const jsonl = (f: string, r: unknown[]) => fs.writeFileSync(path.join(outDir, f), r.map((x) => JSON.stringify(x)).join("\n") + "\n");
  jsonl("listings.jsonl", lrows);
  jsonl("pairs.jsonl", prow);
  jsonl("photos.jsonl", frows);
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  store.close();
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(JSON.stringify(summary, null, 1));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
