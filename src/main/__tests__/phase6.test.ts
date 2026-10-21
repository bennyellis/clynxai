// Phase 6 accuracy items: a settings file saved with a byte-order mark is not "damaged"; every entry records why it exists. Throwaway files only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonFileSafe } from "../safeFs.js";
import { Store } from "../store.js";
import { check, run, section } from "./_testkit.js";

run(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-p6-"));
  section("a byte-order mark (Notepad / PowerShell 'UTF-8') is not damage");
  const f = path.join(dir, "config.json");
  fs.writeFileSync(f, "﻿" + JSON.stringify({ a: 1 }));
  const r = readJsonFileSafe<{ a: number }>(f);
  check("the file loads as it is, is not moved aside, and nothing is reset", r.status === "ok" && r.value?.a === 1 && fs.existsSync(f) && fs.readdirSync(dir).length === 1, r);
  fs.writeFileSync(f, "{ not json");
  check("a really broken file is still treated as damaged", readJsonFileSafe(f).status === "damaged");

  section("why an entry exists");
  const store = new Store(path.join(dir, "scout.db"));
  const a = store.addProductStub("a", "Zorblax 3000", { reason: "found in a listing", detail: "Zorblax 3000 like new" });
  const b = store.addProductStub("b", "Quuxatron 9");
  const c = store.createManualProduct("c", "My Own Thing", "Other", null);
  check("the reason and detail are kept", store.getProductOrigin(a)?.reason === "found in a listing" && store.getProductOrigin(a)?.detail === "Zorblax 3000 like new");
  check("an entry made without saying why still has an honest answer", store.getProductOrigin(b)?.reason === "unspecified");
  check("a hand-made entry says so", store.getProductOrigin(c)?.reason === "added by you");
  check("a name that matched an existing entry does not overwrite why it was first made", (() => { store.addProductStub("a2", "Zorblax 3000", { reason: "asked in chat" }); return store.getProductOrigin(a)?.reason === "found in a listing"; })());
  store.deleteProduct(a);
  check("deleting the entry removes its record", store.getProductOrigin(a) === null);
  section("the visible note when colours were folded");
  const xm = store.addProductStub("xm", "Sony WH-1000XM5 Black");
  store.addProductStub("xm2", "Sony WH-1000XM5 Silver");
  store.addProductStub("xm3", "sony wh-1000xm5 midnight blue");
  const note = store.foldedNoticeFor(xm);
  check("it names the colours that share the entry and the names kept, and says sales are not split by colour", !!note && note.colours.length >= 2 && note.names.length >= 2 && /share one entry/.test(note.text) && /no sold sales to compare/.test(note.text), note);
  store.updateProductEbayComps(xm, { avgSoldPriceUsd: 300, avgRunTimeDays: 3, avgShippingUsd: 0, sampleSize: 9, activeMedianUsd: 310, activeSampleSize: 5, estimatedValueUsd: 300, estimateBasis: "sold", identity: "exact" });
  check("with sales it counts them together and does not invent a per-colour comparison", /All 9 sold sales/.test(store.foldedNoticeFor(xm)?.text ?? "") && /not split by colour/.test(store.foldedNoticeFor(xm)?.text ?? ""));
  check("an entry nothing was folded into has no note", store.foldedNoticeFor(store.addProductStub("plain", "Zorblax Deluxe 3000")) === null);
  section("the owner edits an entry's other names");
  const aa = store.addProductStub("al1", "Quuxatron 9000");
  check("an added name finds the entry", store.addProductAlias(aa, "the quux", "owner") && store.findMatchingProduct("the quux")?.id === aa);
  check("removing it stops that", store.removeProductAlias(aa, "The  Quux") && store.findProductIdByAlias("the quux") === null && !store.removeProductAlias(aa, "the quux"));
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp cleanup can fail on Windows */
  }
});
