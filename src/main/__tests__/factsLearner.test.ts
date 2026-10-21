// Phase 1.1: model facts learned from eBay item specifics, kept with their source, owner-correctable, and used when naming (a colour the built-in list does not know is still folded).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { learnFromAspects } from "../factsLearner.js";
import { namingFacts, resolveName } from "../namingEngine.js";
import { Store } from "../store.js";
import { check, run, section } from "./_testkit.js";

run(async () => {
  section("reading item specifics");
  const facts = learnFromAspects([
    { name: "Color", values: [{ value: "cosmic zing", count: 14 }, { value: "Black", count: 40 }, { value: "Other", count: 9 }, { value: "typo zeel", count: 1 }] },
    { name: "Storage Capacity", values: [{ value: "2 TB", count: 12 }, { value: "2TB", count: 5 }, { value: "1TB", count: 30 }] },
    { name: "Edition", values: [{ value: "Galaxy", count: 6 }, { value: "N/A", count: 20 }] },
    { name: "Type", values: [{ value: "Home Console", count: 90 }] },
  ]);
  const find = (a: string, v: string) => facts.find((f) => f.attribute === a && f.value === v);
  check("colours, sizes and editions are read; junk, rare typos and descriptions are not", find("colour", "Cosmic Zing")?.count === 14 && find("colour", "Black")?.count === 40 && !facts.some((f) => /other|zeel|home console|n\/a/i.test(f.value)));
  check("sizes are written one way and counted together ('2 TB' and '2TB')", find("capacity", "2TB")?.count === 17 && find("capacity", "1TB")?.count === 30);
  check("an edition is kept", find("edition", "Galaxy")?.count === 6);

  section("kept in the Database, with the source, and the owner can say a value is not real");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-learn-"));
  const store = new Store(path.join(dir, "scout.db"));
  store.recordLearnedFacts("Zorblax Console", facts);
  const list = store.listLearnedFacts("Zorblax Console");
  check("listed by line, each with its source", list.length === facts.length && list.every((l) => l.source === "ebay_specifics" && !l.ignored));
  store.recordLearnedFacts("Zorblax Console", [{ attribute: "colour", value: "Cosmic Zing", count: 20 }]);
  check("a second look updates the count instead of piling up", store.listLearnedFacts("Zorblax Console").find((l) => l.value === "Cosmic Zing")?.count === 20 && store.listLearnedFacts("Zorblax Console").length === facts.length);
  check("learned colours are offered to naming", store.learnedColours().includes("cosmic zing"));
  check("the owner can mark one as not real; it is then not offered, and stays that way after another look", (() => {
    store.setLearnedFactIgnored("Zorblax Console", "colour", "Cosmic Zing", true);
    store.recordLearnedFacts("Zorblax Console", [{ attribute: "colour", value: "Cosmic Zing", count: 25 }]);
    const row = store.listLearnedFacts("Zorblax Console").find((l) => l.value === "Cosmic Zing");
    return row?.ignored === true && row.source !== "ebay_specifics" && !store.learnedColours().includes("cosmic zing");
  })());

  section("naming uses what was learned");
  const without = resolveName("Zorblax Console Cosmic Zing", namingFacts());
  const withLearned = resolveName("Zorblax Console Cosmic Zing", namingFacts([], ["cosmic zing"]));
  check("without the fact the unknown colour stays in the name", without.canonical === "Zorblax Console Cosmic Zing");
  check("with it the colour is folded out and the note says which", withLearned.canonical === "Zorblax Console" && withLearned.folded.some((f) => f.kind === "colour" && /cosmic zing/i.test(f.value)), withLearned);
  check("a learned colour that contains a built-in colour word is removed whole", resolveName("Zorblax Console Cosmic Black", namingFacts([], ["cosmic black"])).canonical === "Zorblax Console");
  check("the built-in colours still work alongside", resolveName("Sony WH-1000XM5 Silver", namingFacts([], ["cosmic zing"])).canonical === "Sony WH-1000XM5");
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp cleanup can fail on Windows */
  }
});
