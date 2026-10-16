// Config > Reset Clynx: the database part (every table emptied, nothing else broken) and the Config part (defaults, only the intended things kept), on a real on-disk Store.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { Store } from "../store.js";
import { LibraryOps } from "../libraryOps.js";
import { fileImage } from "../fileImage.js";
import { DEFAULT_CONFIG } from "../config.js";
import { freshConfig, RESET_CONFIRM_WORD, RESET_ERASES, RESET_KEEPS } from "../resetClynx.js";
import { RESET_KEEPS_TABLES } from "../resetText.js";
import { scoredListing } from "./_fixtures.js";
import { check, run, section } from "./_testkit.js";
import type { Config } from "../types.js";

run(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-reset-"));
  const file = path.join(dir, "scout.db");
  let store = new Store(file);
  const ops = new LibraryOps(store);
  const png = `data:image/png;base64,${(await sharp({ create: { width: 120, height: 120, channels: 3, background: "#2255cc" } }).png().toBuffer()).toString("base64")}`;

  // a Clynx that has been used a lot
  const add = (id: string, name: string, family: string) => { const real = store.addProductStub(id, name); store.updateProductProfile(real, { aiSummary: "learned", category: "Video Games & Consoles", family, imageUrl: png }); return real; };
  const p1 = add("a", "Nintendo Switch OLED Console", "Nintendo > Consoles");
  add("b", "Xbox Series X Console", "Xbox > Consoles");
  fileImage(store, p1, png, { sourceKind: "listing", title: "Nintendo Switch OLED Console white", proposer: "test" });
  ops.run({ op: "createFolder", parentId: null, name: "Flips" }, { actor: "ui" });
  ops.run({ op: "renameAutoFolder", key: "Video Games & Consoles > Nintendo > Consoles", name: "Nintendo Hardware" }, { actor: "ui" });
  ops.run({ op: "recordFolderThumbnail", key: "Video Games & Consoles > Nintendo > Consoles", imageData: png, source: "auto", meta: {} }, { actor: "system" });
  store.knowledgeGraph().upsert({ kind: "family", name: "Learned family", itemKind: "hardware" });
  store.saveKnowledge({ key: "meta quest 3", name: "Meta Quest 3", capacities: ["128gb", "512gb"], distinctModels: [], differences: [], summary: "", sources: [], queries: [], backends: [], researchedAt: Date.now() });
  store.addUsage("web_search", 3, 0.1);
  store.addBlacklistTerm("scam word", "user");
  store.saveScored(scoredListing("Xbox Series X", 200, { isDeal: false }, { id: "l1", description: "works" }));
  store.setFeedback("l1", "good" as never, "nice");
  store.createWatch({ name: "w", searchPhrase: "ps5", matchKeywords: ["ps5"], linkedProductId: null, minPriceUsd: null, maxPriceUsd: null, minProfitUsd: null, minDiscountPercent: null, maxListingAgeMinutes: null, locationMode: "country", selectedState: null, selectedCityOrZip: null, searchRadiusMiles: null });
  store.addPendingCloudDelete("product", "earlier-deleted");
  const count = (t: string) => Number((store.database.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n);
  const tables = () => (store.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((r) => r.name);
  const nonEmpty = () => tables().filter((t) => count(t) > 0 && !(RESET_KEEPS_TABLES as readonly string[]).includes(t));

  section("before: it really is full");
  check("products, photos, folders, knowledge, listings, corrections, watches and the ledger all hold data", ["products", "product_images", "library_folders", "folder_meta", "kg_entities", "product_knowledge", "usage_counters", "blacklist_terms", "listings", "feedback", "watches"].every((t) => count(t) > 0), tables().map((t) => `${t}:${count(t)}`).join(" "));

  section("the ids Clynx Cloud must be told to forget");
  const ids = store.listIdsForCloudReset();
  check("every product, watch and correction id is listed", ids.products.length === 2 && ids.watches.length === 1 && ids.feedback.join() === "l1");

  section("the reset");
  const r = store.resetAllData();
  check("every table of user data is empty afterwards (found by looking at ALL tables, not a list)", nonEmpty().length === 0 && r.tables > 20, nonEmpty().map((t) => `${t}:${count(t)}`));
  check("only the cloud-delete record and the schema markers are kept", count("pending_cloud_deletes") === 1 && (RESET_KEEPS_TABLES as readonly string[]).join() === "pending_cloud_deletes,schema_flags");
  check("foreign keys are enforced again", Number((store.database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys) === 1);
  check("the Library reads as empty and has no leftover folder names", store.listProductIndex().length === 0 && store.listFolders().length === 0 && store.listFolderMeta().length === 0 && store.listTrash().products.length === 0);
  check("learned knowledge is gone", store.getKnowledge("meta quest 3") === null && Object.keys(store.knowledgeGraph().counts()).length === 0);

  section("and it is a working Clynx again");
  const again = store.addProductStub("z", "Meta Quest 3");
  store.updateProductProfile(again, { aiSummary: "new", category: "Electronics", family: null, imageUrl: null });
  check("new products can be added, in the same place as on a fresh install", store.listProductIndex().length === 1 && store.getProductById(again)?.aiSummary === "new");
  check("folders and folder operations work again", new LibraryOps(store).run({ op: "createFolder", parentId: null, name: "Flips" }, { actor: "ui" }).ok);
  check("the database file is still a valid database after the reset and the restart", (() => { store.close(); store = new Store(file); return store.listProductIndex().length === 1 && Number((store.database.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check === "ok" ? 1 : 0) === 1; })());
  void p1;

  section("the Config after a reset");
  const used: Config = { ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)), cloud: { enabled: true, apiUrl: "https://my.server" }, customInstructions: "be brief", searchItems: [{ item: "ps5", matchKeywords: ["ps5"], typicalResaleUsd: 300 } as never], dealThresholdPercent: 77, onboarding: { completed: true } as never, theme: "light", accounts: [{ ...DEFAULT_CONFIG.accounts[0], id: "acc-1", label: "My Facebook" }] };
  const f1 = freshConfig(used, { keepFacebook: true });
  check("settings, instructions, Search For and the tour are back to the defaults", f1.customInstructions === "" && f1.searchItems.length === 0 && f1.dealThresholdPercent === DEFAULT_CONFIG.dealThresholdPercent && f1.theme === DEFAULT_CONFIG.theme && f1.onboarding === undefined);
  check("the connection to Clynx Cloud is kept", f1.cloud?.apiUrl === "https://my.server" && f1.cloud?.enabled === true);
  check("the Facebook accounts (and so their logins) are kept unless asked", f1.accounts.length === 1 && f1.accounts[0].id === "acc-1");
  const f2 = freshConfig(used, { keepFacebook: false });
  check("asked to remove them, a single default account comes back", f2.accounts.length === 1 && f2.accounts[0].id === "default");
  check("the defaults object itself is never changed", DEFAULT_CONFIG.customInstructions === "" && DEFAULT_CONFIG.accounts[0].id === "default" && f1 !== DEFAULT_CONFIG && f1.accounts !== used.accounts);

  section("the words the person reads");
  check("the dialog says what is erased and what is kept, and needs a typed word", RESET_ERASES.length >= 4 && RESET_KEEPS.length >= 3 && RESET_CONFIRM_WORD === "RESET" && RESET_KEEPS.some((k) => /sign-in/.test(k)) && RESET_ERASES.some((k) => /Library/.test(k)));
  store.close();
});
