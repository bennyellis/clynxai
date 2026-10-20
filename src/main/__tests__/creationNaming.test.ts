// Phase 2.1 of the Beta 30 plan: the naming rules and the alias lookup on the creation paths (addProductStub, createManualProduct) and in findMatchingProduct. Throwaway Database, nothing of the owner's.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../store.js";
import { check, run, section } from "./_testkit.js";

run(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-creation-"));
  const store = new Store(path.join(dir, "scout.db"));
  const names = () => store.listProducts().map((p) => p.name).sort();

  section("the same model under different names is one entry, whichever path made it");
  const a = store.addProductStub("a", "Xbox Series X Digital Edition");
  check("a known model is filed under its one simple name, the typed name kept as an alias", store.getProductById(a)?.name === "Xbox Series X Digital (White)" && store.listProductAliases(a).some((x) => x.alias === "Xbox Series X Digital Edition"), names());
  check("another name for it returns the same entry and keeps that name too", store.addProductStub("b", "Xbox Series X Robot White") === a && store.listProductAliases(a).some((x) => x.alias === "Xbox Series X Robot White"));
  check("a manual add of yet another spelling returns it too", store.createManualProduct("c", "xbox series x all-digital", "Other", null) === a && names().length === 1, names());

  section("a name that only says the line keeps the line's name, and a later model name finds it");
  const line = store.addProductStub("d", "Xbox Series S");
  check("no colour is guessed into the name", store.getProductById(line)?.name === "Xbox Series S", names());
  check("'Xbox Series S 512GB' is the same default model: one entry", store.addProductStub("e", "Xbox Series S 512GB") === line && store.addProductStub("f", "Xbox Series S (White, 512GB)") === line);
  check("a different size or colour is a different entry", store.addProductStub("g", "Xbox Series S 1TB Black") !== line && store.addProductStub("h", "Xbox Series S 1TB") !== line);
  check("Series X and Series S never merge", store.addProductStub("i", "Xbox Series X") !== line);

  section("colours that do not move the price share one entry; a name nothing is known about is left alone");
  const m1 = store.addProductStub("m1", "Sony WH-1000XM5 Black");
  check("the colour is out of the name", store.getProductById(m1)?.name === "Sony WH-1000XM5");
  check("the other colours land on it", store.addProductStub("m2", "Sony WH-1000XM5 Silver") === m1 && store.addProductStub("m3", "sony wh-1000xm5 midnight blue") === m1);
  const z = store.addProductStub("z", "Zorblax Deluxe 3000");
  check("an unknown name keeps its words exactly and gets no alias", store.getProductById(z)?.name === "Zorblax Deluxe 3000" && store.listProductAliases(z).length === 0);

  section("lookups by an alias or the canonical name are exact");
  check("findMatchingProduct finds the entry by a kept alias", store.findMatchingProduct("Xbox Series X Robot White")?.id === a);
  check("and by a name only the facts know", store.findMatchingProduct("Xbox Series X Digital 1TB")?.id === a);
  check("aliases come back grouped by product for searches", (store.aliasesByProduct().get(a) ?? []).length >= 2);

  section("deleted entries do not capture a new name");
  store.deleteProduct(z);
  check("the name makes a fresh entry", store.addProductStub("z2", "Zorblax Deluxe 3000") === "z2");
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp cleanup can fail on Windows */
  }
});
