// Phase 4 veto-only identity safeguard. Part 1: the decision on its own, across categories (ambiguous identities, rare items, accessories, bundles, editions, unfamiliar
// categories). Expectations were written from the requirements before the code ran on them. "unsure" and "allow" both mean the match stands; the only way a match is
// removed is "veto", and a wrongly vetoed legitimate match is the failure that matters most.
// Part 2: how the Store uses it: off changes nothing, shadow only logs, enforce stops a vetoed match from being filed, valued or added to, nothing else changes, nothing is
// ever put in its place, and a failure never blocks a listing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildContext } from "../identity/foundationResolver.js";
import { evaluateMatch } from "../identity/safeguard.js";
import { IdentitySafeguard } from "../identity/safeguardRuntime.js";
import { Store } from "../store.js";
import { check, run, section } from "./_testkit.js";
import { scoredListing } from "./_fixtures.js";

const NAMES = [
  // phones / consoles
  "iPhone 15", "iPhone 15 Plus", "iPhone 15 Pro", "iPhone 15 Pro Max", "iPhone 14", "Xbox Series S", "Xbox Series S 1TB", "Xbox Series X", "Xbox One S", "PlayStation 5", "PlayStation 5 Pro",
  "DualSense Wireless Controller", "DualSense Charging Station", "Nintendo 3DS", "Pokémon Y (Nintendo 3DS)", "Nintendo Switch", "Nintendo Switch Dock",
  // instruments, cameras, tools, kitchen, vehicles, furniture, books, collectibles, apparel
  "Fender Player Stratocaster", "Fender American Professional II Stratocaster", "Fender Stratocaster", "Boss DS-1 Distortion", "Boss DS-1X Distortion", "Canon EOS R6", "Canon EOS R6 Mark II",
  "Canon RF 24-70mm f/2.8L Lens", "Canon RF 70-200mm f/2.8L Lens", "DeWalt DCD791 20V Drill", "DeWalt DCD771 20V Drill", "KitchenAid Artisan Stand Mixer", "KitchenAid Classic Stand Mixer",
  "Dyson V11 Vacuum", "Dyson V15 Detect Vacuum", "2015 Honda Civic EX", "2015 Honda Civic Si", "IKEA Kallax Shelf Unit 4x4", "IKEA Kallax Shelf Unit 2x2", "The Hobbit Hardcover",
  "Harry Potter and the Sorcerer's Stone", "Pokemon Charizard Base Set 1st Edition Card", "Nike Air Jordan 1 High OG", "Nike Air Jordan 1 Low", "Levi's 501 Original Jeans 32x30", "Levi's 501 Original Jeans 34x32",
  "Casio G-Shock GA-2100", "Casio G-Shock GA-2100 Carbon", "Instant Pot Duo 6 Quart", "Instant Pot Duo 8 Quart", "Hario V60 Dripper",
];
const entries = NAMES.map((name, i) => ({ id: `s${i}`, name }));
const byName = (n: string) => entries.find((e) => e.name === n)!;
const docs = [
  { text: "Fender Stratocaster electric guitar sunburst", origin: "seller:a", kind: "listing" as const },
  { text: "Canon EOS R6 mirrorless camera body", origin: "seller:b", kind: "listing" as const },
  { text: "iPhone 15 Pro Max 256GB unlocked", origin: "seller:c", kind: "listing" as const },
  { text: "iPhone 14 Pro 128GB", origin: "seller:d", kind: "listing" as const },
  { text: "Dyson V11 cordless vacuum cleaner", origin: "seller:e", kind: "listing" as const },
];
const ctx = buildContext(entries, docs);
const decide = (title: string, matched: string | null, entryName: string) => evaluateMatch({ title, matchedName: matched, entry: byName(entryName) }, entries, ctx);

run(() => {
  section("a legitimate match is never vetoed (it may be confirmed or left unsure, but it stands)");
  {
    const legit: Array<[string, string | null, string]> = [
      ["Xbox Series S 512GB console, works great", "Xbox Series S", "Xbox Series S"],
      ["Fender Stratocaster electric guitar sunburst", "Fender Stratocaster", "Fender Stratocaster"],
      ["Canon EOS R6 body only, low shutter count", "Canon EOS R6", "Canon EOS R6"],
      ["Dyson V15 Detect cordless vacuum with all attachments", "Dyson V15 Detect Vacuum", "Dyson V15 Detect Vacuum"],
      ["iPhone 15 Pro Max 256GB unlocked", "iPhone 15 Pro Max", "iPhone 15 Pro Max"],
      ["Casio G-Shock GA-2100 Carbon core guard", "Casio G-Shock GA-2100 Carbon", "Casio G-Shock GA-2100 Carbon"],
      ["Instant Pot Duo 8 Quart pressure cooker", "Instant Pot Duo 8 Quart", "Instant Pot Duo 8 Quart"],
      ["Apple iPhone 14 unlocked", "iPhone 14", "iPhone 14"],
      ["Nintendo Switch console with dock and charger", "Nintendo Switch", "Nintendo Switch"],
      ["PlayStation 5 w/ controller", "PlayStation 5", "PlayStation 5"],
      ["Hario V60 Dripper ceramic white", "Hario V60 Dripper", "Hario V60 Dripper"],
      ["IKEA Kallax 2x2 shelf unit white", "IKEA Kallax Shelf Unit 2x2", "IKEA Kallax Shelf Unit 2x2"],
    ];
    const vetoed = legit.filter(([t, m, e]) => decide(t, m, e).decision === "veto");
    check("none of the legitimate matches is vetoed", vetoed.length === 0, vetoed);
    check("plain titles that state what the entry states are confirmed (allow)", legit.filter(([t, m, e]) => decide(t, m, e).decision === "allow").length >= 9);
  }

  section("a different product is vetoed, in any category");
  {
    const cases: Array<[string, string | null, string, string]> = [
      ["Dyson V15 Detect cordless vacuum", "Dyson V11 Vacuum", "Dyson V11 Vacuum", "another model of the same maker"],
      ["Instant Pot Duo 8 Quart", "Instant Pot Duo 6 Quart", "Instant Pot Duo 6 Quart", "another size"],
      ["Fender American Professional II Stratocaster sunburst", "Fender Player Stratocaster", "Fender Player Stratocaster", "another guitar line"],
      ["DeWalt DCD771 20V drill driver", "DeWalt DCD791 20V Drill", "DeWalt DCD791 20V Drill", "another model number"],
      ["KitchenAid Classic Stand Mixer white", "KitchenAid Artisan Stand Mixer", "KitchenAid Artisan Stand Mixer", "another model"],
      ["Levi's 501 Original Jeans 34x32", "Levi's 501 Original Jeans 32x30", "Levi's 501 Original Jeans 32x30", "another size"],
      ["2015 Honda Civic Si coupe", "2015 Honda Civic EX", "2015 Honda Civic EX", "another trim"],
      ["Nike Air Jordan 1 Low", "Nike Air Jordan 1 High OG", "Nike Air Jordan 1 High OG", "high vs low"],
      ["Harry Potter and the Sorcerer's Stone paperback", "The Hobbit Hardcover", "The Hobbit Hardcover", "another book"],
      ["Xbox Series X console 1TB black", "Xbox Series S", "Xbox Series S", "X vs S"],
    ];
    const missed = cases.filter(([t, m, e]) => decide(t, m, e).decision !== "veto").map((c) => c[0] + " -> " + c[2]);
    check("each is vetoed", missed.length === 0, missed);
  }

  section("accessories, parts, games and companions of the matched product are vetoed");
  {
    const cases: Array<[string, string | null, string]> = [
      ["Pokémon Y (Nintendo 3DS)", "Nintendo 3DS", "Nintendo 3DS"],
      ["Strap for Canon EOS R6 camera", "Canon EOS R6", "Canon EOS R6"],
      ["Case for Canon EOS R6 camera, padded", "Canon EOS R6", "Canon EOS R6"],
      ["Wired controller for Xbox Series S", "Xbox Series S", "Xbox Series S"],
    ];
    const missed = cases.filter(([t, m, e]) => decide(t, m, e).decision !== "veto").map((c) => c[0] + " -> " + c[2]);
    check("a game or accessory is not the console or camera it goes with", missed.length === 0, missed);
  }

  section("uncertainty is not a veto: ambiguous, rare, bundle, edition and unfamiliar cases stand");
  {
    const unsure: Array<[string, string | null, string]> = [
      ["Xbox Series S 1TB Black", "Xbox Series S", "Xbox Series S"], // a more specific size of the matched family: the family entry stands (a capacity is not enough)
      ["Brand new sealed Xbox Series S", "Xbox Series S", "Xbox Series S"],
      ["Xbox Series S and a blue transparent controller", "Xbox Series S", "Xbox Series S"], // a bundle with an extra
      ["Fender Stratocaster 1978 vintage rare", "Fender Stratocaster", "Fender Stratocaster"], // rare words the entry does not have
      ["Hario V60 Dripper plus filters", "Hario V60 Dripper", "Hario V60 Dripper"],
      ["Mystery lot of cables", "Xbox Series S", "Xbox Series S"], // nothing in the title says anything about the entry
      ["FREE WITH ANY PURCHASE!", "iPhone 15", "iPhone 15"],
      ["Selling my old camera", "Canon EOS R6", "Canon EOS R6"],
      ["Xbox Series X Halo Infinite Special Edition console", "Xbox Series X", "Xbox Series X"], // an edition
      ["Nintendo Switch OLED white console", "Nintendo Switch", "Nintendo Switch"], // a model with no entry of its own
      ["Pokemon Charizard Base Set 1st Edition holo card PSA 9", "Pokemon Charizard Base Set 1st Edition Card", "Pokemon Charizard Base Set 1st Edition Card"], // a graded rare item
      ["Harry Potter and the Sorcerer's Stone first edition hardcover signed", "Harry Potter and the Sorcerer's Stone", "Harry Potter and the Sorcerer's Stone"],
      ["Bundle: iPhone 14 with case, charger and screen protector", "iPhone 14", "iPhone 14"], // a bundle with accessories
    ];
    const vetoed = unsure.filter(([t, m, e]) => decide(t, m, e).decision === "veto").map((c) => c[0] + " -> " + c[2]);
    check("none of them is vetoed", vetoed.length === 0, vetoed);
    const conflict = decide("Canon EOS R6 mirrorless body", "Canon EOS R6 Mark II", "Canon EOS R6");
    check("the extracted name alone can veto only where the title is silent, and never over a title that confirms the entry", conflict.decision !== "veto", conflict);
    const silentTitle = decide("Camera for sale, great condition", "Canon EOS R6", "Canon EOS R6");
    check("a title that says nothing about the entry, with the name that picked it, stands", silentTitle.decision !== "veto", silentTitle);
    const markTwo = decide("Canon EOS R6 Mark II body with grip", "Canon EOS R6", "Canon EOS R6");
    check("KNOWN LIMIT: a 'Mark II' is a different camera, but nothing in this Database shows 'mark' separating entries elsewhere, so it is left unsure (not vetoed)", markTwo.decision === "unsure", markTwo);
  }

  section("the veto reports why, and what it pointed at, without choosing anything");
  {
    const d = decide("Dyson V15 Detect cordless vacuum", "Dyson V11 Vacuum", "Dyson V11 Vacuum");
    check("a veto has a reason and evidence", d.decision === "veto" && d.reason.length > 10 && d.evidence.length > 0, d);
    check("it names what the text is, for the record only", d.against?.name === "Dyson V15 Detect Vacuum", d);
  }

  section("the unverified-code rule of stage 1.1 is untouched: a seller's code never makes a veto");
  {
    const d = decide("Xbox Series S Console Z7UX", "Xbox Series S", "Xbox Series S");
    check("a code nobody else uses is not a reason to say it is a different product", d.decision !== "veto", d);
  }

  // ---------------------------------------------------------------- the Store
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-guard-"));
  const seedNames: Array<[string, string, number | null]> = [
    ["g11", "iPhone 14", 450], ["g12", "iPhone 14 Plus", 520], ["g13", "iPhone 13", 380], ["g14", "iPhone 13 Plus", 430], ["g15", "iPhone 12", 280], ["g16", "iPhone 12 Plus", 330], ["g1", "Nintendo Switch Dock", 20], ["g2", "Nintendo Switch", 230], ["g3", "iPhone 15", 500], ["g4", "iPhone 15 Plus", 600], ["g5", "PlayStation 5", 420], ["g6", "DualSense Charging Station", 25],
    ["g7", "Xbox Series S", 190], ["g8", "Xbox Series X", 380], ["g9", "Canon EOS R6", 1400], ["g10", "Canon EOS R6 Mark II", 2200],
  ];
  function seed(file: string): void {
    new Store(file).close();
    const db = new DatabaseSync(file);
    const ins = db.prepare("INSERT INTO products (id, name, category, created_at, ebay_avg_sold_price_usd, ebay_comps_sample_size) VALUES (?, ?, 'Other', ?, ?, 8)");
    seedNames.forEach(([id, name, v], i) => ins.run(id, name, 1_700_000_000_000 + i, v));
    db.close();
  }
  const open = (name: string, mode: "off" | "shadow" | "enforce", log?: Array<Record<string, unknown>>) => {
    const file = path.join(dir, name + ".db");
    seed(file);
    const s = new Store(file);
    s.setIdentitySafeguard(mode, log ? (r) => log.push(r) : null);
    return { s, file };
  };
  const wrong = { title: "Sony PlayStation 5 Digital Edition with 2 DualSense Controllers", matched: "DualSense Charging Station" }; // the real filing error found in the audit
  const right = { title: "Xbox Series S 512GB console works", matched: "Xbox Series S" };
  const rowsOf = (file: string, sql: string) => {
    const db = new DatabaseSync(file, { readOnly: true });
    const r = db.prepare(sql).all();
    db.close();
    return r as Array<Record<string, unknown>>;
  };
  const save = (s: Store, id: string, t: { title: string; matched: string }) => {
    const sc = scoredListing(t.title, 300, { extraction: { matchedItem: t.matched, extractedAttributes: "", conditionImpact: "none", confidence: "high", reasoning: "." } as never });
    sc.listing.id = id;
    s.saveScored(sc);
  };

  section("Store, mode off: exactly the old behaviour, and nothing is even built");
  {
    const { s } = open("off", "off");
    save(s, "L1", wrong);
    save(s, "L2", right);
    const pid = (s as never as { db: DatabaseSync }).db.prepare("SELECT product_id FROM listings WHERE id = 'L1'").get() as { product_id: string | null };
    check("the wrong match is filed (that is the existing behaviour)", pid.product_id === "g6", pid);
    check("its value is used as before", s.getEbayValueForProductName(wrong.matched, wrong.title) === 25);
    check("its signals are offered as before", s.getProductSignals(wrong.matched, wrong.title)?.name === "DualSense Charging Station");
    check("the safeguard computed nothing", s.safeguard.stats.evaluated === 0 && s.safeguard.stats.contextBuilds === 0);
    s.close();
  }

  section("Store, mode shadow: decisions are logged, behaviour is identical to off");
  {
    const log: Array<Record<string, unknown>> = [];
    const { s, file } = open("shadow", "shadow", log);
    save(s, "L1", wrong);
    save(s, "L2", right);
    const pid = rowsOf(file, "SELECT id, product_id FROM listings ORDER BY id");
    check("the wrong match is still filed in shadow mode", pid.find((r) => r.id === "L1")?.product_id === "g6", pid);
    check("its value is still used in shadow mode", s.getEbayValueForProductName(wrong.matched, wrong.title) === 25);
    check("the veto was logged with a reason", log.some((r) => r.decision === "veto" && r.site === "filing" && String(r.entry) === "DualSense Charging Station" && String(r.reason).length > 5), log);
    check("the legitimate match was logged as not vetoed", log.some((r) => r.entry === "Xbox Series S" && r.decision !== "veto"), log);
    s.close();
  }

  section("Store, mode enforce: a vetoed match is not filed, valued, offered or shown; nothing replaces it");
  {
    const log: Array<Record<string, unknown>> = [];
    const { s, file } = open("enforce", "enforce", log);
    const before = rowsOf(file, "SELECT id, name FROM products ORDER BY id");
    save(s, "L1", wrong);
    save(s, "L2", right);
    const rows = rowsOf(file, "SELECT id, title, product_id FROM listings ORDER BY id");
    check("the listing is still saved and visible (discovery is preserved)", rows.length === 2 && rows[0].title === wrong.title);
    check("but it is not filed under the wrong entry", rows[0].product_id === null, rows[0]);
    check("and it is not filed under any other entry either (nothing is put in its place)", rows[0].product_id === null);
    check("the legitimate listing is filed as before", rows[1].product_id === "g7", rows[1]);
    check("a vetoed match gives no value (no confident valuation from a different product)", s.getEbayValueForProductName(wrong.matched, wrong.title) === null);
    check("a legitimate match keeps its value", s.getEbayValueForProductName(right.matched, right.title) === 190);
    check("a vetoed match offers no signals", s.getProductSignals(wrong.matched, wrong.title) === null);
    check("a legitimate match offers its signals", s.getProductSignals(right.matched, right.title)?.valueUsd === 190);
    const shown = s.getById("L1");
    check("the Feed shows no market value taken from the wrong entry", shown?.matchedProductAvgSoldPriceUsd == null, shown?.matchedProductAvgSoldPriceUsd);
    check("the Feed shows the legitimate listing's value", s.getById("L2")?.matchedProductAvgSoldPriceUsd === 190);
    check("no Database entry was created, renamed, merged or removed", JSON.stringify(rowsOf(file, "SELECT id, name FROM products ORDER BY id")) === JSON.stringify(before));
    check("the veto was logged", log.some((r) => r.decision === "veto" && r.mode === "enforce"), log);
    s.close();
  }

  section("Store, enforce: a listing whose entry is only 'related' keeps its match (the other variant of the family)");
  {
    const { s } = open("enforce2", "enforce");
    save(s, "L3", { title: "iPhone 15 128GB unlocked", matched: "iPhone 15" });
    const r = rowsOf(path.join(dir, "enforce2.db"), "SELECT product_id FROM listings");
    check("an exact model keeps its entry", r[0].product_id === "g3", r);
    save(s, "L4", { title: "iPhone 15+ unlocked", matched: "iPhone 15" });
    const r2 = rowsOf(path.join(dir, "enforce2.db"), "SELECT id, product_id FROM listings ORDER BY id");
    check("'15+' is the Plus, a different product from the matched iPhone 15: not filed there", r2.find((x) => x.id === "L4")?.product_id === null, r2);
    s.close();
  }

  section("the safeguard fails open and cannot break a scan");
  {
    const sg = new IdentitySafeguard({
      entries: () => {
        throw new Error("boom");
      },
      evidenceDocs: () => [],
    });
    sg.setMode("enforce");
    check("an error inside is swallowed and the match stands", sg.vetoes({ title: "x y z", matchedName: "x", entry: { id: "a", name: "x" }, site: "t" }) === false && sg.stats.errors === 1);
    sg.setMode("enforce");
    const sg2 = new IdentitySafeguard({ entries: () => [{ id: "a", name: "Widget One" }], evidenceDocs: () => [] });
    sg2.setMode("enforce");
    check("an entry the resolver does not know yet stands", sg2.vetoes({ title: "Widget Two", matchedName: null, entry: { id: "unknown", name: "Widget Zero" }, site: "t" }) === false);
    check("an empty title and name cannot be judged and stand", sg2.vetoes({ title: "", matchedName: null, entry: { id: "a", name: "Widget One" }, site: "t" }) === false);
    check("mode 'off' never builds anything", (() => {
      const sg3 = new IdentitySafeguard({ entries: () => { throw new Error("must not be called"); }, evidenceDocs: () => [] });
      return sg3.vetoes({ title: "a", matchedName: "b", entry: { id: "x", name: "y" }, site: "t" }) === false && sg3.stats.contextBuilds === 0;
    })());
  }
});
