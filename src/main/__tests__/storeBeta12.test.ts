// Beta 12 on a REAL SQLite file: re-evaluation bookkeeping, the candidates for re-judging, lifecycle counts, and a database that has never heard of any of it.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../store.js";
import { check, run, section } from "./_testkit.js";
import { scoredListing } from "./_fixtures.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-b12-"));

run(() => {
  section("a database from before Beta 12 opens, keeps every row, and gains only a side table");
  const file = path.join(dir, "old.db");
  let s = new Store(file);
  s.saveScored(scoredListing("Xbox Series X", 200, { isDeal: false, research: { status: "confirmed_unprofitable", code: "UNPROFITABLE_AT_PRICE", reason: "x" } }, { id: "a1", description: "works" }));
  s.close();
  const raw = new DatabaseSync(file);
  raw.exec("DROP TABLE listing_reeval"); // exactly what a Beta 11 database looks like
  raw.close();
  s = new Store(file);
  check("the old row is untouched", s.getById("a1")?.title === "Xbox Series X" && s.countListings() === 1);
  check("the side table is created on open", s.getListingState("a1")?.reevalCount === 0);

  section("re-evaluation bookkeeping survives re-saves of the same listing");
  s.noteReevaluation("a1");
  s.noteReevaluation("a1");
  s.saveScored(scoredListing("Xbox Series X", 150, { isDeal: false, research: { status: "confirmed_unprofitable", code: "UNPROFITABLE_AT_PRICE", reason: "y" } }, { id: "a1", description: "works" }));
  const st = s.getListingState("a1")!;
  check("count and time are kept across INSERT OR REPLACE", st.reevalCount === 2 && st.lastReevalAt !== null, st);
  check("the SAME record was updated (one row, new price, first-seen kept)", s.countListings() === 1 && st.price === 150);
  check("an unknown listing has no state", s.getListingState("nope") === null);

  section("listings that can be judged again without a page visit");
  s.saveScored(scoredListing("Xbox Series X 1TB", 250, { isDeal: false, extraction: { matchedItem: "Xbox Series X", extractedAttributes: "", conditionImpact: "none", confidence: "medium", reasoning: "r" }, research: { status: "insufficient_evidence", code: "AI_UNVERIFIED", reason: "no numbers" } }, { id: "w1" }));
  s.saveScored(scoredListing("Xbox Series X 1TB", 250, { isDeal: false, extraction: { matchedItem: "Xbox Series X", extractedAttributes: "", conditionImpact: "none", confidence: "medium", reasoning: "r" }, research: { status: "insufficient_evidence", code: "INTERRUPTED", reason: "closed" } }, { id: "w2" }));
  s.saveScored(scoredListing("Vintage camera", 250, { isDeal: false, extraction: { matchedItem: null, extractedAttributes: "", conditionImpact: "none", confidence: "low", reasoning: "r" }, research: { status: "insufficient_evidence", code: "AI_UNVERIFIED", reason: "no numbers" } }, { id: "w3" }));
  const ids = s.listRequalifyCandidates(0, 10);
  check("worth-a-look listings with a matched item qualify (not an interrupted one, not one with nothing matched)", ids.includes("w1") && !ids.includes("w2") && !ids.includes("w3") && !ids.includes("a1"), ids);
  check("a deal that was already alerted is never a candidate", (() => { s.markNotified("w1"); return !s.listRequalifyCandidates(0, 10).includes("w1"); })());
  check("the freshness window is respected", s.listRequalifyCandidates(Date.now() + 60_000, 10).length === 0);

  section("lifecycle counts add up to the saved total");
  s.saveScored(scoredListing("Xbox Series X", 100, { isDeal: true, research: { status: "researched", code: "DEAL", reason: "d" } }, { id: "d1", description: "x" }));
  s.saveScored(scoredListing("Couch", 100, { isDeal: false, research: { status: "rejected", code: "UNSHIPPABLE", reason: "u" } }, { id: "u1", description: "" }));
  s.saveScored(scoredListing("Old thing", 100, { isDeal: false, research: { status: "rejected", code: "TOO_OLD", reason: "o" } }, { id: "o1", description: "x" }));
  const c = s.lifecycleCounts();
  const sum = Object.values(c.stages).reduce((a, b) => a + b, 0);
  check("every saved listing is in exactly one stage", c.total === s.countListings() && sum === c.total, c);
  check("the deal, the unshippable skip, the too-old rejection and the unprofitable one are in the right stages", c.stages.profitable === 1 && c.stages.prefiltered === 1 && c.stages.postfiltered === 1 && c.stages.unprofitable === 1, c.stages);
  check("only a verdict counts as fully evaluated", c.fullyEvaluated === 2, c);
  s.close();
});
