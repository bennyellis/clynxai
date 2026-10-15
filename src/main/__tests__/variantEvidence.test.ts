// Evidence-based verification (variantEvidence.ts): an exact-title miss is never a denial, manufacturer evidence wins, and the chat is only told
// something was saved when it was. Searches are faked, so every case is deterministic and offline.
import { CLYNX_PERSONA } from "../clynxPersona.js";
import {
  EvidenceLedger,
  assessVariantEvidence,
  buildQueryPlan,
  classifySource,
  brandLabels,
  describeEvidence,
  describeResearchOutcome,
  gatherEvidence,
  mayFileVariant,
  type EvidenceSource,
  type SearchDeps,
} from "../variantEvidence.js";
import { check, run, section } from "./_testkit.js";

type Page = { title: string; url: string; text: string };

/** A fake web: a query returns every page whose key words (all of them) appear in the query, else nothing. */
function fakeWeb(pages: Page[], triggers: Array<[RegExp, number[]]>): SearchDeps & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async search(query) {
      queries.push(query);
      for (const [re, idxs] of triggers) if (re.test(query)) return idxs.map((i) => ({ title: pages[i].title, url: pages[i].url, snippet: pages[i].text.slice(0, 80) }));
      return [];
    },
    async fetchPage(url) {
      return pages.find((p) => p.url === url)?.text ?? null;
    },
  };
}

const GALAXY = "Xbox Series X 2TB Galaxy Black Special Edition";
const PARENT = "Xbox Series X";

run(async () => {
  section("hosts are classified by who owns them");
  const xboxBrands = brandLabels(GALAXY);
  check("the brand's own site (and its parent company's) is the manufacturer", classifySource("https://www.xbox.com/en-us/consoles/xbox-series-x", xboxBrands) === "manufacturer" && classifySource("https://support.microsoft.com/x", xboxBrands) === "manufacturer");
  check("a marketplace is a marketplace", classifySource("https://www.ebay.com/itm/123", xboxBrands) === "marketplace");
  check("a big retailer is a retailer (it may be a third-party seller's wording)", classifySource("https://www.walmart.com/ip/1", xboxBrands) === "retailer");
  check("press", classifySource("https://www.theverge.com/x", xboxBrands) === "press");
  check("an unrelated site that happens to share a word is NOT the manufacturer", classifySource("https://www.galaxy.com/", brandLabels("Samsung Galaxy S24")) === "other");
  check("Apple's support site is the manufacturer of an iPhone", classifySource("https://support.apple.com/x", brandLabels("iPhone 15 Pro")) === "manufacturer");
  check("Amazon is the manufacturer of a Kindle but a retailer of anything else", classifySource("https://www.amazon.com/dp/1", brandLabels("Kindle Paperwhite")) === "manufacturer" && classifySource("https://www.amazon.com/dp/1", xboxBrands) === "retailer");

  section("the search plan does not stop at the exact title");
  const plan = buildQueryPlan({ name: GALAXY, parentName: PARENT });
  check("the exact name is tried first", plan[0] === GALAXY);
  check("then the manufacturer's own site with the distinguishing words", plan.some((q) => /^site:xbox\.com .*galaxy/.test(q)), plan);
  check("the parent product is searched with the distinguishing words and for its lineup", plan.some((q) => /^Xbox Series X .*galaxy.* official$/i.test(q)) && plan.some((q) => /models editions official/i.test(q)), plan);
  check("alternate wordings are tried", plan.some((q) => /2 ?TB/.test(q) && !/bundle/i.test(q)), plan);
  check("no duplicates", new Set(plan.map((q) => q.toLowerCase())).size === plan.length);

  section("THE REGRESSION: the exact title finds nothing, the manufacturer's page does -> verified");
  {
    const pages: Page[] = [
      { title: "Xbox Series X – 2TB Galaxy Black Special Edition | Xbox", url: "https://www.xbox.com/en-US/consoles/xbox-series-x", text: "Shop the Xbox Series X – 2TB Galaxy Black Special Edition with a 2TB custom SSD." },
    ];
    // only the manufacturer-site query and the parent query reach it; the exact title returns nothing
    const web = fakeWeb(pages, [[/site:xbox\.com/, [0]], [/official/, [0]]]);
    const out = await gatherEvidence({ name: GALAXY, parentName: PARENT, userReported: true }, web);
    check("the exact-title search came back empty", web.queries[0] === GALAXY);
    check("research continued instead of concluding", web.queries.length >= 2, web.queries);
    check("verified by the manufacturer", out.evidence.status === "verified" && out.evidence.basis === "manufacturer", out.evidence);
    check("and stopped once it was settled", web.queries.length <= 3, web.queries);
    check("the page is kept as a source for the write-up", out.sources.length === 1 && out.sources[0].url.includes("xbox.com"));
    check("a verified variant may be filed", mayFileVariant(out.evidence));
    check("the chat is told to treat it as real", /VERIFIED/.test(describeEvidence(out.evidence)) && /real product/.test(describeEvidence(out.evidence)));
  }

  section("a seller's listing alone is a lead, not proof: unverified, never 'fake'");
  {
    const src: EvidenceSource[] = [
      { title: "Xbox Series X 2TB Galaxy Black Special Edition - eBay", url: "https://www.ebay.com/itm/1", excerpt: "Xbox Series X 2TB Galaxy Black Special Edition new sealed" },
      { title: "Xbox Series X 2TB Galaxy Black - Mercari", url: "https://www.mercari.com/us/item/2", excerpt: "xbox series x 2tb galaxy black" },
    ];
    const ev = assessVariantEvidence({ name: GALAXY, parentName: PARENT, sources: src, userReported: true });
    check("unverified", ev.status === "unverified" && ev.basis === "listing-only", ev);
    check("it may still be filed (flagged), because something real names it", mayFileVariant(ev));
    const said = describeEvidence(ev);
    check("the chat is told not to call it fake or official", /UNVERIFIED/.test(said) && /Do not call it fake/.test(said), said);
  }

  section("a retailer page plus a press page corroborate; one retailer page alone does not");
  {
    const walmart: EvidenceSource = { title: "Xbox Series X 2TB Galaxy Black Special Edition", url: "https://www.walmart.com/ip/Microsoft-Xbox-Series-X-2TB-Console-Galaxy-Black-Special-Edition/14579873332", excerpt: "Microsoft Xbox Series X 2TB Console Galaxy Black Special Edition" };
    const verge: EvidenceSource = { title: "Microsoft announces Galaxy Black 2TB Xbox Series X", url: "https://www.theverge.com/x", excerpt: "the Xbox Series X 2TB Galaxy Black Special Edition arrives" };
    check("one retailer page: unverified", assessVariantEvidence({ name: GALAXY, parentName: PARENT, sources: [walmart] }).status === "unverified");
    const both = assessVariantEvidence({ name: GALAXY, parentName: PARENT, sources: [walmart, verge] });
    check("two independent sources: verified (corroborated)", both.status === "verified" && both.basis === "corroborated", both);
  }

  section("nothing found anywhere: unknown, which is not a denial");
  {
    const web = fakeWeb([], []);
    const out = await gatherEvidence({ name: "Xbox Series X Cosmic Quantum Edition 8TB", parentName: PARENT }, web);
    check("several searches were tried before giving up", web.queries.length >= 3, web.queries);
    check("unknown", out.evidence.status === "unknown" && out.evidence.basis === "none", out.evidence);
    const said = describeEvidence(out.evidence);
    check("it says the product was not found, not that it does not exist", /UNKNOWN/.test(said) && /does not show it does not exist|not that it does not exist|Never say it does not exist/i.test(said), said);
    check("it is not filed as a product", !mayFileVariant(out.evidence));
    check("it was never labelled disproven", out.evidence.status !== "disproven");
  }

  section("what the user reports is never ignored");
  {
    const ev = assessVariantEvidence({ name: GALAXY, parentName: PARENT, sources: [], userReported: true });
    check("reported by the user and nothing confirms it yet: unverified, not unknown", ev.status === "unverified" && ev.basis === "user-report", ev);
    check("and the wording says that is not evidence against it", /not evidence against it/.test(ev.reasons.join(" ")));
  }

  section("disproven needs the manufacturer to say so about those very words");
  {
    const mfr: EvidenceSource = { title: "Xbox Series X models", url: "https://www.xbox.com/en-US/consoles", excerpt: "There is no such Cosmic Quantum Edition 8TB Xbox Series X; the console ships in 1TB and 2TB." };
    const ev = assessVariantEvidence({ name: "Xbox Series X Cosmic Quantum Edition 8TB", parentName: PARENT, sources: [mfr] });
    check("disproven", ev.status === "disproven", ev);
    check("it is not filed", !mayFileVariant(ev));
    const unrelatedNegation: EvidenceSource = { title: "Xbox", url: "https://www.xbox.com/x", excerpt: "A disc drive is not available on the Series S. Cosmic wallpaper packs 8TB archive." };
    check("a negation about something else is not a disproof", assessVariantEvidence({ name: "Xbox Series X Cosmic Quantum Edition 8TB", parentName: PARENT, sources: [unrelatedNegation] }).status !== "disproven");
    const seller: EvidenceSource = { title: "fake cosmic quantum 8tb xbox series x", url: "https://www.ebay.com/itm/9", excerpt: "no such thing, not an official cosmic quantum 8tb" };
    check("a marketplace saying so is not a manufacturer", assessVariantEvidence({ name: "Xbox Series X Cosmic Quantum Edition 8TB", parentName: PARENT, sources: [seller] }).status !== "disproven");
  }

  section("one failing search does not end the research");
  {
    let n = 0;
    const flaky: SearchDeps = {
      async search(q) {
        n++;
        if (n === 1) throw new Error("search engine unreachable");
        return /site:xbox/.test(q) ? [{ title: "Galaxy", url: "https://www.xbox.com/p", snippet: "Xbox Series X 2TB Galaxy Black Special Edition" }] : [];
      },
      async fetchPage() {
        return "Xbox Series X 2TB Galaxy Black Special Edition";
      },
    };
    const out = await gatherEvidence({ name: GALAXY, parentName: PARENT }, flaky);
    check("it carried on and found the manufacturer", out.evidence.status === "verified", out.evidence);
  }

  section("diverse real-world products: legitimate, seller-invented, bundles, accessories, nonexistent");
  const cases: Array<{ label: string; name: string; parent: string; pages: Page[]; expect: "verified" | "unverified" | "unknown"; filed: boolean }> = [
    { label: "iPhone 15 Pro 256GB Blue Titanium (apple.com)", name: "iPhone 15 Pro 256GB Blue Titanium", parent: "iPhone 15", pages: [{ title: "iPhone 15 Pro", url: "https://www.apple.com/iphone-15-pro/specs/", text: "iPhone 15 Pro 256GB in Blue Titanium" }], expect: "verified", filed: true },
    { label: "Samsung Galaxy S24 Ultra 512GB (samsung.com)", name: "Samsung Galaxy S24 Ultra 512GB", parent: "Samsung Galaxy S24", pages: [{ title: "Galaxy S24 Ultra", url: "https://www.samsung.com/us/smartphones/galaxy-s24-ultra/", text: "Galaxy S24 Ultra 512GB storage" }], expect: "verified", filed: true },
    { label: "Switch OLED Zelda Edition (nintendo.com)", name: "Nintendo Switch OLED Zelda Edition", parent: "Nintendo Switch OLED", pages: [{ title: "Zelda Edition", url: "https://www.nintendo.com/zelda-oled", text: "Nintendo Switch OLED Model The Legend of Zelda Tears of the Kingdom Edition zelda" }], expect: "verified", filed: true },
    { label: "Xbox Series S Fortnite Bundle (retail bundle, retailer + press)", name: "Xbox Series S Fortnite Bundle", parent: "Xbox Series S", pages: [{ title: "Xbox Series S Fortnite bundle", url: "https://www.bestbuy.com/p", text: "Xbox Series S Fortnite bundle" }, { title: "Fortnite bundle", url: "https://www.ign.com/a", text: "Xbox Series S Fortnite Bundle announced" }], expect: "verified", filed: true },
    { label: "Dyson V8 Absolute (dyson.com)", name: "Dyson V8 Absolute", parent: "Dyson V8", pages: [{ title: "V8 Absolute", url: "https://www.dyson.com/vacuum-cleaners/cordless/v8", text: "Dyson V8 Absolute cordless vacuum" }], expect: "verified", filed: true },
    { label: "seller-invented edition found only on eBay", name: "PlayStation 5 Dragon Edition 4TB", parent: "PlayStation 5", pages: [{ title: "PS5 Dragon Edition 4TB", url: "https://www.ebay.com/itm/5", text: "playstation 5 dragon edition 4tb" }], expect: "unverified", filed: true },
    { label: "nonexistent: nothing anywhere", name: "iPhone 15 Pro 12TB Rose Gold", parent: "iPhone 15", pages: [], expect: "unknown", filed: false },
    { label: "an unrelated page mentioning only the parent", name: "Dyson V8 Platinum Gold 9TB", parent: "Dyson V8", pages: [{ title: "Dyson V8", url: "https://www.dyson.com/v8", text: "Dyson V8 cordless vacuum cleaner" }], expect: "unknown", filed: false },
  ];
  for (const c of cases) {
    const web = fakeWeb(c.pages, c.pages.length ? [[/./, c.pages.map((_, i) => i)]] : []);
    const out = await gatherEvidence({ name: c.name, parentName: c.parent }, web);
    check(`${c.label} -> ${c.expect}`, out.evidence.status === c.expect, out.evidence);
    check(`${c.label}: ${c.filed ? "filed" : "not filed"}`, mayFileVariant(out.evidence) === c.filed);
  }

  section("conversation consistency: earlier evidence is carried and not silently downgraded");
  {
    const ledger = new EvidenceLedger();
    const verified = assessVariantEvidence({ name: GALAXY, parentName: PARENT, sources: [{ title: "Xbox", url: "https://www.xbox.com/p", excerpt: "Xbox Series X 2TB Galaxy Black Special Edition" }] });
    ledger.record(GALAXY, verified, 1000);
    check("the finding is in the next prompt", /Galaxy Black/.test(ledger.render(2000)) && /VERIFIED/.test(ledger.render(2000)));
    ledger.record("xbox series x galaxy black 2tb special edition", assessVariantEvidence({ name: GALAXY, parentName: PARENT, sources: [] }), 3000);
    check("a later empty search does not turn a verified finding into 'unknown'", ledger.list(4000).length === 1 && ledger.list(4000)[0].status === "verified", ledger.list(4000));
    const unverified = new EvidenceLedger();
    unverified.record(GALAXY, assessVariantEvidence({ name: GALAXY, parentName: PARENT, sources: [], userReported: true }), 1000);
    unverified.record(GALAXY, verified, 2000);
    check("new evidence upgrades unverified to verified", unverified.list(3000)[0].status === "verified");
    check("old findings expire", ledger.render(1000 + 4 * 60 * 60 * 1000) === "");
    check("an empty ledger adds nothing to the prompt", new EvidenceLedger().render() === "");
    check("the prompt tells the model not to contradict without new evidence", /do not contradict them without new evidence/.test(ledger.render(2000)));
  }

  section("database integrity: 'saved' is only said when it is true");
  const saved = { name: GALAXY, aiSummary: "Variant status: VERIFIED...\n\nProfile text", loading: false };
  const ev = assessVariantEvidence({ name: GALAXY, parentName: PARENT, sources: [{ title: "Xbox", url: "https://www.xbox.com/p", excerpt: GALAXY }] });
  const ok = describeResearchOutcome({ requested: GALAXY, saved, state: "finished", evidence: ev, parentName: PARENT });
  check("a finished, written entry says Saved, as a variant of its parent", ok.startsWith("Saved") && /variant of "Xbox Series X"/.test(ok), ok);
  const failed = describeResearchOutcome({ requested: GALAXY, saved: { ...saved, aiSummary: "(Research failed: timeout)" }, state: "finished" });
  check("a failed lookup is reported as a failure and not as saved", failed.startsWith("Failed:") && !/^Saved/.test(failed), failed);
  const running = describeResearchOutcome({ requested: GALAXY, saved: { ...saved, aiSummary: "", loading: true }, state: "still-running" });
  check("an unfinished lookup says NOT saved yet", /NOT saved yet/.test(running) && !running.startsWith("Saved") && !running.startsWith("Failed"), running);
  const stillLoading = describeResearchOutcome({ requested: GALAXY, saved: { ...saved, loading: true }, state: "finished" });
  check("an entry still flagged as loading is not reported as saved", !stillLoading.startsWith("Saved"), stillLoading);
  const gone = describeResearchOutcome({ requested: GALAXY, saved: null, state: "finished" });
  check("an entry that does not exist is a failure", gone.startsWith("Failed:"), gone);
  const unsupported = describeResearchOutcome({ requested: "Xbox Series X Cosmic Quantum Edition 8TB", saved: null, state: "discarded", evidence: assessVariantEvidence({ name: "Xbox Series X Cosmic Quantum Edition 8TB", parentName: PARENT, sources: [] }) });
  check("an unsupported variant is reported as not saved, with why and what would help", /^Not saved/.test(unsupported) && /does not support it as a product/.test(unsupported) && /manufacturer's page/.test(unsupported), unsupported);

  section("the chat's standing instructions carry the policy");
  check("persona separates verified / unverified / unknown / disproven", /VERIFIED/.test(CLYNX_PERSONA) && /UNVERIFIED/.test(CLYNX_PERSONA) && /UNKNOWN/.test(CLYNX_PERSONA) && /DISPROVEN/.test(CLYNX_PERSONA));
  check("persona forbids calling an empty search fake", /never "fake"/.test(CLYNX_PERSONA));
  check("persona puts manufacturer evidence first", /Manufacturer evidence beats everything/.test(CLYNX_PERSONA));
  check("persona keeps variants and parents apart and refuses substitute comps", /Never quote the standard model's sold prices/.test(CLYNX_PERSONA));
  check("persona only allows 'saved' after research_product says Saved", /actually reported that it saved it/.test(CLYNX_PERSONA));
});
