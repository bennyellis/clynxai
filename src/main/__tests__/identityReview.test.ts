// Phase 4 Database review: the findings and the suggestions are right and clearly labelled, a run changes nothing, the preview shows exactly the stored values that would
// change, approving is refused while it is switched off (and the refusal is in the audit history), there is no bulk operation, and the app contains no code that applies a
// suggestion.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IdentityReview } from "../identityReview.js";
import { analyzeReview } from "../identity/reviewFindings.js";
import { Store } from "../store.js";
import { check, run, section } from "./_testkit.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-review-"));
const file = path.join(dir, "scout.db");

const PRODUCTS: Array<[string, string, string, number | null, number | null]> = [
  ["r1", "Xbox Series S", "Games", 190, 8], ["r2", "Xbox Series X", "Games", 380, 9], ["r3", "PlayStation 5 Slim", "Games", 430, 7], ["r4", "Astro Bot (PS5)", "Games", 30, 5],
  ["r5", "Meta Quest 3", "Games", 400, 6], ["r6", "Meta Quest 3S", "Games", 280, 6], ["r7", "Fender Stratocaster", "Instruments", 700, 5], ["r8", "Fender Player Stratocaster", "Instruments", 650, 5],
  ["r9", "xbox", "Games", 2130, 1], ["r10", "Xbox Series S 1TB", "Games", 230, 4], ["r11", "Terraria (Xbox One)", "Games", null, null], ["r12", "Apple iPhone 11", "Phones", 140, 1],
  ["r13", "iPhone 11", "Phones", 260, 6], ["r14", "Terraria", "Games", null, null], ["r15", "fender stratocaster", "Instruments", 450, 3],
];
function seed(target: string = file): void {
  new Store(target).close();
  const db = new DatabaseSync(target);
  const ins = db.prepare("INSERT INTO products (id, name, category, created_at, ebay_avg_sold_price_usd, ebay_comps_sample_size, image_url) VALUES (?, ?, ?, ?, ?, ?, NULL)");
  PRODUCTS.forEach(([id, name, cat, v, n], i) => ins.run(id, name, cat, 1_700_000_000_000 + i, v, n));
  const img = db.prepare("INSERT INTO product_images (id, product_id, image_data, source_title, created_at) VALUES (?, ?, 'data:x', ?, 1)");
  img.run("i1", "r4", "Sony PlayStation 5 Slim Bundle with 2 Controllers and 2 Games"); // a console bundle photo under a game
  img.run("i2", "r4", "Astro Bot PS5 game disc sealed");
  img.run("i3", "r5", "eBay listing: Meta Quest 3S 128GB headset");
  img.run("i4", "r5", "Meta Quest 3 512GB headset");
  img.run("i5", "r1", "Microsoft Xbox Series S 512GB console");
  img.run("i6", "r9", "Xbox Series S 1TB console black");
  const lst = db.prepare("INSERT INTO listings (id, title, url, first_seen_at, source, seller_name, product_id) VALUES (?, ?, 'https://x', 1, 'facebook', ?, ?)");
  lst.run("L1", "Fender Player Stratocaster sunburst", "a", "r7"); // filed under the wrong Strat
  lst.run("L2", "Xbox Series S console", "b", "r1");
  db.close();
}
const rows = () => {
  const db = new DatabaseSync(file, { readOnly: true });
  const out = JSON.stringify([db.prepare("SELECT * FROM products ORDER BY id").all(), db.prepare("SELECT id, product_id, source_title FROM product_images ORDER BY id").all(), db.prepare("SELECT id, product_id FROM listings ORDER BY id").all()]);
  db.close();
  return out;
};

run(async () => {
  seed();
  const store = new Store(file);

  section("the findings are classified, labelled confirmed or heuristic, and explained");
  const before = rows();
  const result = await analyzeReview(store.readReviewInput());
  const cats = new Set(result.findings.map((f) => f.category));
  check("incorrect filing is found (a console bundle photo under a game, a Quest 3S photo under the Quest 3, a Player Strat listing under the other Strat)", cats.has("incorrect-filing"), [...cats]);
  check("a generic entry holding a more specific item is found", cats.has("generic-entry"), [...cats]);
  check("a suspected duplicate is found", cats.has("suspected-duplicate"), [...cats]);
  check("a suspicious valuation is found (a value on the family-level 'xbox' entry; a one-sale average)", cats.has("suspicious-valuation"), [...cats]);
  check("an ambiguous identity is found (a one-word entry with nothing filed)", cats.has("ambiguous-identity"), [...cats]);
  check("every finding says whether its evidence is confirmed or a heuristic, and every evidence line does too", result.findings.every((f) => (f.strength === "confirmed" || f.strength === "heuristic") && f.evidence.every((e) => e.strength === "confirmed" || e.strength === "heuristic")));
  check("every finding has a plain summary and a side-by-side table", result.findings.every((f) => f.summary.length > 5 && f.rows.length > 0));
  const bundle = result.findings.find((f) => f.category === "incorrect-filing" && f.productId === "r4");
  check("the bundle photo under the game is incorrect filing, with the evidence quoted and a move suggested", !!bundle && bundle.evidence.some((e) => /Slim Bundle/.test(e.text)) && bundle.proposalIds.length > 0, bundle);
  check("generating the review changed nothing in the Database", rows() === before);

  section("the preview shows exactly what would change");
  {
    const move = result.proposals.find((p) => p.action === "move-photo" && p.productId === "r4")!;
    check("a move names the photo, the field, where it is now and where it would go", move.preview.length === 1 && move.preview[0].column === "filed under" && move.preview[0].from === "Astro Bot (PS5)" && move.preview[0].to === "PlayStation 5 Slim", move.preview);
    check("and the stored change is that one field of that one row", move.change?.table === "product_images" && move.change.key.id === "i1" && JSON.stringify(move.change.set) === JSON.stringify({ product_id: "r3" }) && move.before?.product_id === "r4");
    const clear = result.proposals.find((p) => p.action === "clear-valuation" && p.productId === "r9");
    check("clearing a value lists each stored number with its present value", !!clear && clear.preview.some((c) => c.column === "average sold price" && c.from === "$2130") && clear.preview.every((c) => c.to === "none"), clear?.preview);
    const dup = result.proposals.find((p) => p.action === "review-merge");
    check("a duplicate suggestion changes no stored data (a person decides)", !dup || (dup.change === null && dup.preview.length === 0), dup);
    check("every suggestion that changes data has a before-value for each field it sets", result.proposals.every((p) => !p.change || Object.keys(p.change.set).every((k) => p.before && k in p.before)));
  }

  section("ids are stable, so a decision about a suggestion survives a re-run");
  {
    const again = await analyzeReview(store.readReviewInput());
    check("the same Database gives the same finding and suggestion ids", JSON.stringify(again.findings.map((f) => f.id)) === JSON.stringify(result.findings.map((f) => f.id)) && JSON.stringify(again.proposals.map((p) => p.id)) === JSON.stringify(result.proposals.map((p) => p.id)));
  }

  section("review-only: approving and rejecting are refused, and the refusal is recorded");
  {
    const rdir = path.join(dir, "rev-off");
    const rv = new IdentityReview(store, rdir, () => false);
    const snap = await rv.run();
    check("the run is available and says it is review-only", snap.mode === "review-only" && snap.decisionsEnabled === false && snap.findings.length > 0);
    const p = snap.proposals[0];
    const r = rv.decide(p.id, "approved");
    check("an approval is refused with a plain reason", r.ok === false && /switched off|review-only/i.test((r as { reason: string }).reason), r);
    check("a rejection is refused too", rv.decide(p.id, "rejected").ok === false);
    check("nothing was recorded as a decision", Object.keys(rv.get()!.decisions).length === 0 && !fs.existsSync(path.join(rdir, "review-decisions.json")));
    const h = rv.history();
    check("the history shows the run and both refused attempts, newest first", h[0].type === "decision-blocked" && h.some((e) => e.type === "analysis-run") && h.filter((e) => e.type === "decision-blocked").length === 2, h.map((e) => e.type));
    check("the run's history entry says it changed nothing", h.find((e) => e.type === "analysis-run")?.detail.changedAnything === false);
    check("the Database is unchanged by all of it", rows() === before);
  }

  section("decisions on: one suggestion at a time, recorded, reversible, never applied");
  {
    const rdir = path.join(dir, "rev-on");
    const rv = new IdentityReview(store, rdir, () => true);
    const snap = await rv.run();
    const [a, b] = snap.proposals;
    check("one approval is recorded", rv.decide(a.id, "approved", "looks right").ok === true && rv.get()!.decisions[a.id]?.decision === "approved" && rv.get()!.decisions[a.id]?.note === "looks right");
    check("a rejection of another is recorded", rv.decide(b.id, "rejected").ok === true && rv.get()!.decisions[b.id]?.decision === "rejected");
    check("a decision can be taken back", rv.decide(a.id, "clear").ok === true && rv.get()!.decisions[a.id] === undefined);
    check("a bulk request (several ids) is refused", rv.decide(`${a.id},${b.id}`, "approved").ok === false);
    check("an unknown suggestion is refused", rv.decide("0123456789ab", "approved").ok === false);
    const rv2 = new IdentityReview(store, rdir, () => true);
    check("decisions survive a restart", rv2.get() === null && (await rv2.run()).decisions[b.id]?.decision === "rejected");
    const h = rv2.history();
    check("every recorded decision says it was NOT applied to the Database", h.filter((e) => e.type === "decision-recorded").every((e) => e.detail.appliedToDatabase === false) && h.some((e) => e.type === "decision-cleared"));
    check("the Database is still unchanged", rows() === before);
  }

  section("the surface: no bulk approval, no apply");
  {
    const names = Object.getOwnPropertyNames(IdentityReview.prototype).filter((n) => n !== "constructor");
    check("the only operations are read, run, history, decide, apply and undo (each takes one suggestion), plus private helpers", JSON.stringify(names.sort()) === JSON.stringify(["apply", "audit", "decide", "get", "history", "mode", "newestBackupAge", "persist", "run", "undo", "validId"]), names);
    const src = fs.readFileSync(path.join(process.cwd(), "src/main/identityReview.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    check("the backend itself contains no SQL (the journal does the one-row change, in identity/correctionJournal.ts)", !/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|SELECT\s)/i.test(src));
    check("it does not import the Database layer (it is handed a reader)", !/from\s+"\.\/store\.js"/.test(src));
    const ui = fs.readFileSync(path.join(process.cwd(), "src/renderer/src/screens/ReviewTab.tsx"), "utf8");
    check("the screen has no approve-all or apply-all control (apply is per suggestion)", !/approve all|apply all|apply (these|changes)|select all/i.test(ui) && !/bulk/i.test(ui.replace(/there is no bulk approval/gi, "").replace(/nothing is ever applied in bulk/gi, "")));
    const main = fs.readFileSync(path.join(process.cwd(), "src/main/index.ts"), "utf8");
    check("the main process exposes only get / run / history / decide / apply / undo for the review (each one suggestion)", ["review:get", "review:run", "review:history", "review:decide", "review:apply", "review:undo"].every((c) => main.includes(`"${c}"`)) && (main.match(/ipcMain\.handle\("review:[a-z]+"/g) ?? []).length === 6);
  }

  store.close();

  section("apply and undo of ONE approved suggestion (isolated databases; flag-gated; journaled; backed up)");
  {
    const dbPath = (n: string) => path.join(dir, `apply-${n}.db`);
    const rowsOf2 = (f: string) => {
      const d = new DatabaseSync(f, { readOnly: true });
      const out = JSON.stringify([d.prepare("SELECT * FROM products ORDER BY id").all(), d.prepare("SELECT id, product_id, source_title FROM product_images ORDER BY id").all(), d.prepare("SELECT id, product_id FROM listings ORDER BY id").all()]);
      d.close();
      return out;
    };
    const setup = async (n: string, flags: { decisions: boolean; apply: boolean }) => {
      const f = dbPath(n);
      seed(f);
      const st = new Store(f);
      const rv = new IdentityReview(st, path.join(dir, `rv-${n}`), { decisionsEnabled: () => flags.decisions, applyEnabled: () => flags.apply, now: () => Date.now() });
      const snap = await rv.run();
      const move = snap.proposals.find((p) => p.action === "move-photo" && p.productId === "r4")!;
      return { f, st, rv, move, snap };
    };

    {
      const { f, st, rv, move } = await setup("off", { decisions: true, apply: false });
      const before = rowsOf2(f);
      rv.decide(move.id, "approved");
      const r = rv.apply(move.id);
      check("approved but apply switched off: refused, nothing changed", r.ok === false && rowsOf2(f) === before && rv.history()[0].type === "correction-refused", r);
      check("no backup and no journal were created", !fs.existsSync(path.join(dir, "rv-off", "backups")) && (() => { const d = new DatabaseSync(f, { readOnly: true }); const t = d.prepare("SELECT name FROM sqlite_master WHERE name = 'correction_journal'").get(); d.close(); return !t; })());
      st.close();
    }
    {
      const { st, rv, move, snap } = await setup("gate", { decisions: true, apply: true });
      check("a suggestion that was never approved cannot be applied", rv.apply(move.id).ok === false);
      rv.decide(move.id, "rejected");
      check("a rejected suggestion cannot be applied", rv.apply(move.id).ok === false);
      const merge = snap.proposals.find((p) => p.action === "review-merge" || p.action === "gather-evidence")!;
      rv.decide(merge.id, "approved");
      check("an approved suggestion that changes no data has nothing to apply", rv.apply(merge.id).ok === false);
      check("several ids at once are refused", rv.apply(`${move.id},${merge.id}`).ok === false);
      st.close();
    }
    {
      const { f, st, rv, move } = await setup("ok", { decisions: true, apply: true });
      const before = rowsOf2(f);
      rv.decide(move.id, "approved", "checked by hand");
      const r = rv.apply(move.id);
      check("an approved suggestion is applied", r.ok === true, r);
      const after = rowsOf2(f);
      const d = new DatabaseSync(f, { readOnly: true });
      const img = d.prepare("SELECT id, product_id FROM product_images WHERE id = 'i1'").get() as { product_id: string };
      const journal = d.prepare("SELECT * FROM correction_journal").all() as Array<{ before_json: string; after_json: string }>;
      d.close();
      const changedPhotos = (JSON.parse(after)[1] as Array<{ product_id: string }>).filter((x, i) => x.product_id !== (JSON.parse(before)[1] as Array<{ product_id: string }>)[i].product_id).length;
      check("exactly that one field of that one row changed", img.product_id === "r3" && after !== before && changedPhotos === 1 && JSON.stringify(JSON.parse(after)[0]) === JSON.stringify(JSON.parse(before)[0]) && JSON.stringify(JSON.parse(after)[2]) === JSON.stringify(JSON.parse(before)[2]));
      check("the journal holds the exact before and after values", journal.length === 1 && JSON.parse(journal[0].before_json).product_id === "r4" && JSON.parse(journal[0].after_json).product_id === "r3");
      const bdir = path.join(dir, "rv-ok", "backups");
      const backups = fs.existsSync(bdir) ? fs.readdirSync(bdir) : [];
      check("a Database backup was made first and it holds the OLD state", backups.length === 1 && rowsOf2(path.join(bdir, backups[0])) === before, backups);
      check("the history says what was applied, the preview and the backup", rv.history().some((e) => e.type === "correction-applied" && !!e.detail.backup && Array.isArray(e.detail.preview)));
      check("applying again is refused", rv.apply(move.id).ok === false);
      check("an applied correction cannot be re-decided until it is undone", rv.decide(move.id, "rejected").ok === false);
      const u = rv.undo(move.id);
      check("undo restores the Database exactly", u.ok === true && rowsOf2(f) === before, u);
      check("the undo is in the history", rv.history()[0].type === "correction-undone");
      check("undoing twice is refused", rv.undo(move.id).ok === false);
      check("it can be applied again after an undo (still approved), with no second backup inside the window", rv.apply(move.id).ok === true && fs.readdirSync(bdir).length === 1);
      st.close();
    }
    {
      const { f, st, rv, move } = await setup("stale", { decisions: true, apply: true });
      rv.decide(move.id, "approved");
      const d = new DatabaseSync(f);
      d.prepare("UPDATE product_images SET product_id = 'r1' WHERE id = 'i1'").run();
      d.close();
      const r = rv.apply(move.id);
      check("a suggestion the Database has moved on from is refused, not forced", r.ok === false && /changed since/i.test((r as { reason: string }).reason), r);
      const d2 = new DatabaseSync(f, { readOnly: true });
      check("and the row keeps the person's edit", (d2.prepare("SELECT product_id FROM product_images WHERE id = 'i1'").get() as { product_id: string }).product_id === "r1");
      d2.close();
      st.close();
    }
    {
      const { f, st, rv, move } = await setup("edit", { decisions: true, apply: true });
      rv.decide(move.id, "approved");
      rv.apply(move.id);
      const d = new DatabaseSync(f);
      d.prepare("UPDATE product_images SET product_id = 'r1' WHERE id = 'i1'").run();
      d.close();
      const u = rv.undo(move.id);
      const d2 = new DatabaseSync(f, { readOnly: true });
      check("an undo never overwrites an edit made after the correction", u.ok === false && (d2.prepare("SELECT product_id FROM product_images WHERE id = 'i1'").get() as { product_id: string }).product_id === "r1", u);
      d2.close();
      st.close();
    }
    {
      const { f, st, rv, snap } = await setup("val", { decisions: true, apply: true });
      const clear = snap.proposals.find((p) => p.action === "clear-valuation" && p.productId === "r9")!;
      const before = rowsOf2(f);
      rv.decide(clear.id, "approved");
      check("a stored value is cleared only after approval", rv.apply(clear.id).ok === true);
      const d = new DatabaseSync(f, { readOnly: true });
      const row = d.prepare("SELECT ebay_avg_sold_price_usd AS v, ebay_comps_sample_size AS n FROM products WHERE id = 'r9'").get() as { v: number | null; n: number | null };
      d.close();
      check("the number is gone", row.v === null && row.n === null);
      check("its undo restores the value exactly", rv.undo(clear.id).ok === true && rowsOf2(f) === before);
      st.close();
    }
  }
});
