// A special edition is valued from sales of that edition only, never from the standard model's sales; names that differ by an edition do not share
// an entry; the evidence and the unrecorded claims are kept with the product, and survive reopening; Clynx's look-up tool reports an empty search
// honestly and widens it. Offline: no network, no AI.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSimilarProductName, Store } from "../store.js";
import { analyzeEbayComps, type EbayComp } from "../watchcount.js";
import { editionConflict } from "../variantIdentity.js";
import { reconcileVerdict, type VariantVerdict, type VerifyDeps } from "../variantEvidence.js";
import { lookUpWithDeps } from "../webResearch.js";
import { check, run, section } from "./_testkit.js";

function comp(title: string, price: number, extra: Partial<EbayComp> = {}): EbayComp {
  return { title, priceUsd: price, shippingUsd: 0, runTimeDays: 2, condition: "Used", imageUrl: null, ...extra } as EbayComp;
}

function verdict(claim: string, status: VariantVerdict["status"], basis = "b"): VariantVerdict {
  return { claim, status, basis, sources: [{ title: "t", url: "https://www.xbox.com/x", host: "xbox.com", sourceClass: "manufacturer", matched: ["xbox"], missing: [], fullMatch: true, negative: false, excerpt: "LONG PAGE TEXT".repeat(100) }], matchedAttributes: ["xbox"], missingAttributes: [], searched: ["q"], checkedAt: 1 };
}

run(async () => {
  const GALAXY = "Xbox Series X 2TB Galaxy Black Special Edition";

  section("edition conflicts: the sale has to be of the same edition");
  check("a standard console sale is not the special edition's", editionConflict(GALAXY, "Microsoft Xbox Series X 2TB Black Console"));
  check("the special edition's own sale is", !editionConflict(GALAXY, "Xbox Series X 2TB Galaxy Black Special Edition Console"));
  check("a theme word the caller knows must be in the title", editionConflict("Xbox Series X 2TB Black", "Xbox Series X 2TB Black Console", ["galaxy"]));
  check("...and passes when it is", !editionConflict("Xbox Series X 2TB Black", "Xbox Series X 2TB Galaxy Black Console", ["galaxy"]));
  check("a standard product is not valued from a limited edition's sale", editionConflict("Xbox Series X 1TB", "Xbox Series X 1TB Halo Infinite Limited Edition Console"));
  check("'limited time' is not an edition", !editionConflict("Xbox Series X 1TB", "Xbox Series X 1TB console - limited time offer, ships fast"));
  check("a plain standard sale is fine", !editionConflict("Xbox Series X 1TB", "Microsoft Xbox Series X 1TB Console Carbon Black"));
  check("a themed edition needs its theme", editionConflict("Nintendo Switch OLED Zelda Edition", "Nintendo Switch OLED White Console"));
  check("...and is matched by it", !editionConflict("Nintendo Switch OLED Zelda Edition", "Nintendo Switch OLED Zelda Edition Console Tears of the Kingdom"));
  check("an anniversary edition is not the base game's sale", editionConflict("Halo Infinite", "Halo Infinite 20th Anniversary Edition"));

  section("sold comps: the special edition is valued only from its own sales; with none, there is no value (not the standard model's)");
  {
    const standard = [comp("Microsoft Xbox Series X 2TB Black Console", 520), comp("Xbox Series X 2TB Carbon Black", 540), comp("Xbox Series X 2TB Console Black - Used", 510)];
    const special = [comp("Xbox Series X 2TB Galaxy Black Special Edition", 690), comp("Microsoft Xbox Series X 2TB Galaxy Black Special Edition Console", 710)];
    const onlyStandard = await analyzeEbayComps(GALAXY, standard, GALAXY);
    check("only standard-model sales: no value at all", onlyStandard.sampleSize === 0 && onlyStandard.avgSoldPriceUsd === null, onlyStandard);
    const mixed = await analyzeEbayComps(GALAXY, [...standard, ...special], GALAXY);
    check("mixed: only the special edition's sales are counted", mixed.sampleSize === 2 && Math.round(mixed.avgSoldPriceUsd ?? 0) === 700, mixed);
    const parentOnly = await analyzeEbayComps("Xbox Series X 2TB Black", [...standard, ...special], "Xbox Series X 2TB Black");
    check("the standard product is not priced from the special edition's sales", parentOnly.sampleSize === 3 && (parentOnly.avgSoldPriceUsd ?? 0) < 560, parentOnly);
    const themed = await analyzeEbayComps("Xbox Series X 2TB Black", standard, "Xbox Series X 2TB Black", null, false, ["galaxy"]);
    check("a theme word separating a variant from its parent keeps the parent's sales out", themed.sampleSize === 0, themed);
  }

  section("names that differ by an edition are separate entries");
  check("special edition is not the standard entry", !isSimilarProductName("Xbox Series X Special Edition", "Xbox Series X"));
  check("...in either direction", !isSimilarProductName("Xbox Series X", "Xbox Series X Special Edition"));
  check("a themed edition is not the standard entry", !isSimilarProductName("Nintendo Switch OLED Zelda Edition", "Nintendo Switch OLED"));
  check("same edition words match", isSimilarProductName("Xbox Series X Special Edition Console", "Xbox Series X Special Edition"));
  check("filler words still fold (console)", isSimilarProductName("Xbox Series X Console", "Xbox Series X"));
  check("the capacity rule still holds", !isSimilarProductName("Xbox Series X 2TB", "Xbox Series X"));
  check("a color still separates entries", !isSimilarProductName("Xbox Series S White", "Xbox Series S Black"));

  section("evidence is kept with the product, unrecorded claims with the parent, and nothing is lost on reopening");
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-variant-"));
    const dbPath = path.join(dir, "scout.db");
    let store = new Store(dbPath);
    const parent = store.addProductStub("parent", "Xbox Series X");
    store.updateProductProfile(parent, { aiSummary: "The console.", category: "Video Games & Consoles", family: "Xbox", imageUrl: null });
    check("a fresh entry has no evidence and no claims", store.getProductById(parent)?.variantEvidence === null && store.getProductById(parent)?.variantClaims.length === 0);

    const child = store.addProductStub("child", GALAXY);
    store.setProductParent(child, parent);
    check("the variant is its own entry", child !== parent && store.getProductById(child)?.name === "Xbox Series X Galaxy Edition" && store.listProductAliases(child).some((a) => a.alias === GALAXY));
    check("the evidence is written", store.setProductVariantEvidence(child, verdict(GALAXY, "verified", "xbox.com lists it")));
    const saved = store.getProductById(child)?.variantEvidence;
    check("status and basis come back", saved?.status === "verified" && saved.basis === "xbox.com lists it", saved);
    check("page text is not stored with the product", saved?.sources.every((s) => s.excerpt === undefined), saved?.sources);
    check("the parent's own profile was not touched", store.getProductById(parent)?.aiSummary === "The console." && store.getProductById(parent)?.variantEvidence === null);
    check("the child is listed under its parent", store.listProductChildren(parent).some((p) => p.id === child));

    store.recordVariantClaim(parent, verdict("Xbox Series X Diamond Gold Edition", "unverified", "nothing found"));
    store.recordVariantClaim(parent, verdict("Xbox Series X Diamond Gold Edition", "unverified", "nothing found, looked again"));
    store.recordVariantClaim(parent, verdict("Xbox Series X Ruby Edition", "unverified", "nothing"));
    const claims = store.getProductById(parent)?.variantClaims ?? [];
    check("a claim checked twice is kept once, newest first", claims.length === 2 && claims[1].basis === "nothing found, looked again" && claims[0].claim === "Xbox Series X Ruby Edition", claims);
    check("the Database still has exactly the two entries", store.listProductIndex().length === 2, store.listProductIndex());

    (store as any).db.close?.();
    store = new Store(dbPath);
    const reopened = store.getProductById(child);
    check("reopened: the evidence is still there", reopened?.variantEvidence?.status === "verified" && reopened.parentProductId === parent, reopened?.variantEvidence);
    check("reopened: the parent's claims are still there", (store.getProductById(parent)?.variantClaims.length ?? 0) === 2);
    check("reopened: existing entries and their profiles are intact", store.getProductById(parent)?.aiSummary === "The console." && store.listProductIndex().length === 2);
    check("writing evidence for a missing product reports failure", !store.setProductVariantEvidence("nope", verdict("x", "verified")) && !store.recordVariantClaim("nope", verdict("x", "unverified")));
  }

  section("a weaker later look never replaces stronger saved evidence");
  {
    const strong = verdict(GALAXY, "verified", "xbox.com lists it");
    const weak = { ...verdict(GALAXY, "unverified", "nothing found this time"), sources: [] };
    check("verified stays", reconcileVerdict(strong, weak).status === "verified");
    check("and keeps its sources", reconcileVerdict(strong, weak).sources.length === 1);
  }

  section("Clynx's web look-up: an empty search is reported as nothing found (not as fake), a link is read, an unreadable link is admitted");
  {
    const empty: VerifyDeps = { async search() { return []; }, async fetchText() { return null; } };
    const out = await lookUpWithDeps(GALAXY, empty);
    check("says the search found nothing readable", /nothing readable/i.test(out), out);
    check("says that does not show it is missing", /says nothing about whether the product exists|does not mean it does not exist/i.test(out), out);
    check("labels it UNVERIFIED and forbids calling it fake", /UNVERIFIED/.test(out) && /Do NOT say it is fake/.test(out), out);
    check("warns not to borrow the standard model's price", /never borrow the standard model's price/i.test(out), out);

    const xbox = "Xbox Series X – 2TB Galaxy Black Special Edition. Xbox Series X – 1TB Carbon Black.";
    let queries: string[] = [];
    const web: VerifyDeps = {
      async search(q) {
        queries.push(q);
        // The exact quoted title finds nothing on this engine; the manufacturer-site search does.
        return /site:xbox\.com/.test(q) ? [{ title: "Xbox Series X | Xbox", url: "https://www.xbox.com/en-us/consoles/xbox-series-x", snippet: xbox.slice(0, 80) }] : [];
      },
      async fetchText(url) {
        return url.includes("xbox.com") ? xbox : null;
      },
    };
    const widened = await lookUpWithDeps(GALAXY, web);
    check("the look-up went past the exact title", queries.length > 1, queries);
    check("it ends VERIFIED from the manufacturer", /VERIFIED/.test(widened) && /xbox\.com/.test(widened) && /Treat it as a real product/.test(widened), widened);

    const linked = await lookUpWithDeps("is this real", empty, "https://www.xbox.com/en-us/consoles/xbox-series-x");
    check("a link that cannot be read is admitted, and Clynx is told not to claim it opened it", /could not read the page/i.test(linked) && /Do NOT claim you opened/.test(linked), linked);
    const priv = await lookUpWithDeps("x", empty, "http://127.0.0.1/admin");
    check("a private address is never opened", /not a public web page/.test(priv), priv);

    const readable: VerifyDeps = { async search() { return []; }, async fetchText(url) { return url.includes("xbox.com") ? xbox : null; } };
    const fromLink = await lookUpWithDeps(GALAXY, readable, "https://www.xbox.com/en-us/consoles/xbox-series-x");
    check("a readable link is shown and decides it", /The page the user linked/.test(fromLink) && /VERIFIED/.test(fromLink), fromLink);
  }
});
