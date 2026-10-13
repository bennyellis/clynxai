// Phase 4 stage 0b: the proposed resolver (shadow mode only) and the shadow analysis, on made-up data across many categories.
import { compareIdentity, identityTokens, learnOptionalWords, looksLikeAbbreviation } from "../identity/resolver.js";
import { assessMixed, comparePairs, genericsWithSpecificSiblings, newTitlePick, resolveListings, type ShadowProduct } from "../identity/shadow.js";
import { isSimilarProductName } from "../store.js";
import { compMatchesSpecs } from "../compFilter.js";
import { check, run, section } from "./_testkit.js";

const P = (id: string, name: string, category = "X", titles: string[] = []): ShadowProduct => ({ id, name, category, parentId: null, valueUsd: null, titles, compsIdentity: null });

run(() => {
  section("tokens");
  {
    check("a lone 'a' after a number is kept (7a is not 7)", compareIdentity("Google Pixel 7a", "Google Pixel 7").level === "line");
    check("a plus sign stays part of the name (S21+ is not S21)", compareIdentity("Samsung Galaxy S21+", "Samsung Galaxy S21").level !== "exact");
    check("glued letters and numbers are split (x360 = x 360)", [...identityTokens("x360").words].join() === "x,360");
    check("a possessive is not a letter (Series X ... Cord's is not a Series S)", compareIdentity("Xbox Series X 1TB Good Condition W/Cord's", "Xbox Series S 1TB").level === "different");
    check("ordinals are numbers (2nd = 2)", compareIdentity("AirPods Pro 2nd", "AirPods Pro 2").level === "exact");
    check("capacity is compared as a value", compareIdentity("Phone 128GB", "Phone 64GB").level === "different" && compareIdentity("Phone 128 GB", "Phone 128gb").level === "exact");
  }

  section("comparison, in both directions, across categories");
  {
    const cases: Array<[string, string, string]> = [
      ["Xbox 360 Wireless Controller 1403", "Xbox Wireless Controller", "line"],
      ["Xbox Series S", "Xbox Series X", "different"],
      ["Galaxy S21 Ultra", "Galaxy S21", "line"],
      ["RTX 3060 Ti", "RTX 3060", "line"],
      ["Milwaukee M18 Battery", "Milwaukee M12 Battery", "different"],
      ["DCD791 Drill", "DCD771 Drill", "different"],
      ["LG 5.2 cu ft Washer", "LG 4.5 cu ft Washer", "different"],
      ["Kallax 4x4", "Kallax 2x2", "different"],
      ["Civic Si 2018", "Civic 2018", "line"],
      ["Charizard 1st Edition Shadowless", "Charizard Base Set", "different"],
      ["Nike Air Force 1 Size 10", "Nike Air Force 1 Size 8", "different"],
      ["PS5 Slim", "PlayStation 5 Slim", "possible-alias"],
      ["Nintendogs", "Nintendo", "possible-alias"],
      ["Camera Body", "Camera Body", "exact"],
    ];
    for (const [a, b, want] of cases) {
      const ab = compareIdentity(a, b);
      const ba = compareIdentity(b, a);
      check(`${a} | ${b} -> ${want}`, ab.level === want, ab);
      check("   ...and swapped is the same relation", ba.level === ab.level && (ab.level !== "line" || ba.moreSpecific !== ab.moreSpecific));
    }
    check("a coincidental short form does not pair words (ds in division) unless it explains the whole difference", compareIdentity("The Division", "Nintendo 2DS").level === "different" && compareIdentity("Destiny 2", "Nintendo 2DS").level === "different");
    check("an abbreviation never bridges a number or a lone letter", !looksLikeAbbreviation("s", "series") && !looksLikeAbbreviation("5", "playstation") && looksLikeAbbreviation("ps", "playstation"));
  }

  section("brand-like leading words are learned from the data, not listed");
  {
    const names = ["Microsoft Xbox One", "Microsoft Xbox 360", "Microsoft Surface Pro", "Microsoft Zune", "Sony Walkman", "Sony Bravia TV", "Sony Alpha Camera", "Sony Cybershot", "Dyson V8 Vacuum"];
    const learned = learnOptionalWords(names);
    check("words that start many names are learned (microsoft, sony)", learned.has("microsoft") && learned.has("sony") && !learned.has("dyson"), [...learned]);
    check("without them, a name with and without the maker is the same product", compareIdentity("Microsoft Xbox Series X", "Xbox Series X", learned).level === "exact" && compareIdentity("Microsoft Xbox Series X", "Xbox Series X").level === "line");
    check("but they still do not hide a real difference", compareIdentity("Microsoft Xbox Series X", "Xbox Series S", learned).level === "different");
  }

  section("shadow analysis: pairs, generics with specific siblings, mixed entries, titles");
  {
    const products = [P("1", "Xbox Wireless Controller", "Games"), P("2", "Xbox 360 Wireless Controller", "Games"), P("3", "Samsung Galaxy S21", "Phones"), P("4", "Samsung Galaxy S21 Ultra", "Phones"), P("5", "DeWalt DCD791 Drill", "Tools")];
    const r = comparePairs(products, isSimilarProductName);
    check("pairs counted", r.pairs === 10);
    check("old says same, new says narrower: both pairs logged as disagreements", r.disagreements.filter((d) => d.kind === "old-same/new-line").length === 2, r.disagreements.map((d) => d.kind));
    check("categories are tallied", r.byCategory["Games"]?.oldSameNewLineOrDifferent === 1 && r.byCategory["Phones"]?.oldSameNewLineOrDifferent === 1);
    check("collisions show the ambiguous lookups", r.collisions.some((c) => c.id === "1" && c.old === 1) && r.collisions.every((c) => c.newExact === 0));

    const g = genericsWithSpecificSiblings([P("1", "Xbox Wireless Controller", "Games", ["Xbox wireless controller black", "Microsoft Xbox 360 wireless controller 1403", "Used xbox controller"]), P("2", "Xbox 360 Wireless Controller", "Games")]);
    check("a title with the specific sibling's words, filed under the generic entry, is flagged", g.length === 1 && g[0].likelyMisfiled.length === 1 && /360/.test(g[0].likelyMisfiled[0]), g);

    const mixed = assessMixed(P("9", "Wireless Controller", "Games", ["wireless controller 1403 black", "wireless controller 1403 used", "wireless controller 1708 white", "wireless controller 1708 oem", "wireless controller 1708 new"]));
    check("titles split into two groups that never co-occur: a mixed entry (by model number)", mixed.assessable && mixed.mixed && mixed.kind === "code", mixed);
    const same = assessMixed(P("8", "Wireless Controller", "Games", ["wireless controller black", "wireless controller used", "wireless controller works", "wireless controller oem black"]));
    check("titles that only vary in condition words are not flagged by model number", !same.mixed || same.kind !== "code", same);
    check("too few titles: not assessable, never guessed", !assessMixed(P("7", "X", "G", ["a", "b"])).assessable);

    const prods2 = [P("a", "Xbox Wireless Controller"), P("b", "Xbox 360 Wireless Controller 1403")];
    const n = newTitlePick("Official Microsoft Xbox 360 & Windows Black Wireless Controller 1403 OEM gamepad", prods2);
    check("a title is resolved to the most specific entry it fully states", n.id === "b" && n.level === "exact", n);
    const n2 = newTitlePick("Used xbox wireless controller", prods2);
    check("an ordinary title resolves to the general entry", n2.id === "a" && n2.level === "exact");
    const rs = resolveListings([{ id: "l", title: "Xbox 360 wireless controller 1403", price: 20, productId: "a" }], prods2, compMatchesSpecs);
    check("old and new picks are both recorded, with the stored link", rs[0].storedProductId === "a" && rs[0].newPick === "b");
  }
});
