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
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp cleanup can fail on Windows */
  }
});
