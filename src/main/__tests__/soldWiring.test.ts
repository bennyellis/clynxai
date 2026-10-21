// Sold prices wiring: why a zero is a zero, and the owner's imported sales reaching the existing analysis (same identity checks, no duplicates). Fake pages and rows only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../store.js";
import { classifySoldPage, explainZeroSold } from "../soldComps/zeroWhy.js";
import { importedCompsForQuery } from "../soldComps/importedForResearch.js";
import { parseSoldImport } from "../soldComps/manualImport.js";
import { check, run, section } from "./_testkit.js";

run(async () => {
  section("what the page was");
  check("cards on the page are results", classifySoldPage("https://www.watchcount.com/x", "", 12) === "results");
  check("a captcha is a security check, not an empty market", classifySoldPage("https://www.google.com/recaptcha/api2", "", 0) === "security_check" && classifySoldPage("https://w.com", "Please verify you are human", 0) === "security_check");
  check("the anonymous cap is a limit", classifySoldPage("https://w.com", "You have reached your daily limit. Sign up or log in to continue", 0) === "limit");
  check("a real empty answer", classifySoldPage("https://w.com", "No results found for your search", 0) === "empty");
  check("anything else is unknown, never guessed", classifySoldPage("https://w.com", "hello", 0) === "unknown");

  section("the sentence in the activity feed");
  check("a limit page says it tells nothing about the market, and offers the import when nothing is imported", /says nothing about whether this sells/.test(explainZeroSold("limit", 0)) && /Import sold prices/.test(explainZeroSold("limit", 0)) && !/Import sold prices/.test(explainZeroSold("limit", 3)));
  check("security check, empty and unknown each read differently", new Set([explainZeroSold("security_check", 0), explainZeroSold("empty", 0), explainZeroSold(null, 0)]).size === 3 && /no sold listings/.test(explainZeroSold("empty", 0)) && /not proof/.test(explainZeroSold(null, 0)));

  section("the owner's imports reach the analysis");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-soldwire-"));
  const store = new Store(path.join(dir, "scout.db"));
  const imp = parseSoldImport("Xbox Series X Galaxy Black 2TB Special Edition $1,099.00\nXbox Series X Galaxy Black 2TB Special Edition - 2 controllers $1,150.00\nDyson V8 Absolute $210.00\nEUR 12,50 Something else in euros");
  store.soldComps().upsertComps(imp.comps);
  check("pasted lines were kept in the Database", store.soldComps().listComps("manual_import").length === imp.comps.length && imp.comps.length >= 3);
  const mine = await importedCompsForQuery(store.soldComps().listComps("manual_import"), "Xbox Series X Galaxy Black 2TB", []);
  check("only rows that share the search's words come through, as USD comps with a price", mine.length === 2 && mine.every((c) => /Xbox/.test(c.title) && c.priceUsd > 1000), mine.map((c) => c.title));
  const dup = await importedCompsForQuery(store.soldComps().listComps("manual_import"), "Xbox Series X Galaxy Black 2TB", [mine[0]]);
  check("a sale WatchCount already returned is not counted twice", dup.length === 1);
  check("nothing imported for an unrelated search", (await importedCompsForQuery(store.soldComps().listComps("manual_import"), "KitchenAid Artisan mixer", [])).length === 0);
  check("removing the imports removes them all", store.soldComps().removeBySource("manual_import") && store.soldComps().listComps("manual_import").length === 0);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp cleanup can fail on Windows */
  }
});
