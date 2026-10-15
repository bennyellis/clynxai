// What happens when someone asks for a more specific version of a product already on file (variantResearch.ts), end to end with a fake web and fake
// Database: variants are checked before they are recorded, kept separate from the parent, unconfirmed claims are never filed or called fake, earlier
// findings are reused, and a link the user gives is read. Xbox Series X 2TB Galaxy Black Special Edition is one case among many.
import { classifySource, verifyVariant, type VariantVerdict, type VerifyDeps } from "../variantEvidence.js";
import { createVerdictMemory, decideResearchTarget, isPublicHttpUrl, makeClaimVerifier, publicHttpUrls, type DecideDeps, type TrackedProduct } from "../variantResearch.js";
import { check, run, section } from "./_testkit.js";

const NOW = 1_700_000_000_000;

function verdict(claim: string, status: VariantVerdict["status"], basis = "test", at = NOW): VariantVerdict {
  return { claim, status, basis, sources: [], matchedAttributes: [], missingAttributes: [], searched: ["q1", "q2"], checkedAt: at };
}

interface World {
  tracked: TrackedProduct[];
  verified: string[];
  verdicts: Record<string, VariantVerdict>;
}

function deps(world: World, matching: (name: string) => TrackedProduct | null = () => null): DecideDeps {
  return {
    findMatching: matching,
    listTracked: () => world.tracked,
    async verify(name) {
      world.verified.push(name);
      return world.verdicts[name] ?? verdict(name, "unverified", "Nothing found that names it. A search turning up nothing does not mean it does not exist.");
    },
  };
}

const XBOX: TrackedProduct = { id: "xbox", name: "Xbox Series X" };
const PS5: TrackedProduct = { id: "ps5", name: "PlayStation 5" };
const IPHONE: TrackedProduct = { id: "iph", name: "iPhone 15 Pro" };
const SWITCH: TrackedProduct = { id: "nsw", name: "Nintendo Switch OLED" };

run(async () => {
  const GALAXY = "Xbox Series X 2TB Galaxy Black Special Edition";

  section("a confirmed variant becomes its own entry under its parent (and is never folded into the parent)");
  {
    const world: World = { tracked: [XBOX, PS5], verified: [], verdicts: { [GALAXY]: verdict(GALAXY, "verified", "The manufacturer's own site (xbox.com) lists it.") } };
    const d = await decideResearchTarget(GALAXY, deps(world));
    check("create_variant", d.kind === "create_variant", d);
    check("its parent is the general Xbox Series X entry", d.kind === "create_variant" && d.parent.id === "xbox", d);
    check("the evidence travels with the decision", d.kind === "create_variant" && d.verdict.status === "verified");
    check("the evidence check ran before anything was recorded", world.verified.length === 1);
  }

  section("the old failure: the general entry matched by name, and the variant used to be folded into it");
  {
    const world: World = { tracked: [XBOX], verified: [], verdicts: { "Xbox Series X Galaxy": verdict("Xbox Series X Galaxy", "supported") } };
    const d = await decideResearchTarget("Xbox Series X Galaxy", deps(world, () => XBOX));
    check("a name that adds a theme is a variant claim, not a refresh of the parent", d.kind === "create_variant" && d.parent.id === "xbox", d);
  }

  section("an unconfirmed claim is NOT recorded as a product and is never called fake");
  {
    const world: World = { tracked: [XBOX], verified: [], verdicts: {} };
    const d = await decideResearchTarget(GALAXY, deps(world));
    check("not_recorded", d.kind === "not_recorded", d);
    if (d.kind === "not_recorded") {
      check("the answer says nothing was saved", /^NOT SAVED/.test(d.message), d.message);
      check("it says unverified, not fake", /unverified/i.test(d.message) && /NOT "fake"/.test(d.message), d.message);
      check("it never says the product is fake or does not exist as a conclusion", !/is (a )?fake\b/i.test(d.message.replace(/NOT "fake".*$/s, "")), d.message);
      check("it asks for a link or a label photo", /link/i.test(d.message) && /label/i.test(d.message), d.message);
      check("the parent is named as unchanged", /"Xbox Series X" is unchanged/.test(d.message), d.message);
      check("the verdict is kept for the next turn", d.verdict.status === "unverified" && d.verdict.claim === GALAXY);
    }
  }

  section("a claim a named source disproves is not recorded either, and the source is named");
  {
    const bad = "Xbox Series X Diamond Gold Edition";
    const world: World = { tracked: [XBOX], verified: [], verdicts: { [bad]: verdict(bad, "disproven", "theverge.com says this exact product is not official or does not exist.") } };
    const d = await decideResearchTarget(bad, deps(world));
    check("not_recorded", d.kind === "not_recorded");
    check("names the source", d.kind === "not_recorded" && /theverge\.com/.test(d.message) && /NOT SAVED/.test(d.message), d);
    check("still invites proof", d.kind === "not_recorded" && /proof|link/i.test(d.message), d);
  }

  section("the same product asked again, or a plainer name, is a refresh with no evidence check");
  {
    const world: World = { tracked: [XBOX], verified: [], verdicts: {} };
    const same = await decideResearchTarget("Xbox Series X", deps(world, () => XBOX));
    check("exact name: refresh", same.kind === "refresh_existing");
    const plain = await decideResearchTarget("Xbox Series X", deps(world, () => ({ id: "x2", name: "Xbox Series X Console" })));
    check("a plainer name than the entry's: refresh", plain.kind === "refresh_existing");
    check("no search was spent", world.verified.length === 0);
  }

  section("accessories, bundles, a different tier and a brand-new product");
  {
    const world: World = { tracked: [XBOX, PS5, IPHONE, SWITCH], verified: [], verdicts: {} };
    const acc = await decideResearchTarget("Xbox Series X Wireless Controller Carbon Black", deps(world));
    check("a controller is its own product, not a variant of the console", acc.kind === "create_product", acc);
    check("so no variant evidence check is run for it", world.verified.length === 0);
    const bundleName = "PlayStation 5 with 2 controllers and 2TB external drive";
    world.verdicts[bundleName] = verdict(bundleName, "supported");
    const bundle = await decideResearchTarget(bundleName, deps(world));
    check("a bundle keeps its relation to the console", bundle.kind === "create_variant" && bundle.parent.id === "ps5", bundle);
    const pro = await decideResearchTarget("iPhone 15 Pro Max 256GB", deps(world));
    check("a different tier (Pro Max) is a new product, not a color of the Pro", pro.kind === "create_product", pro);
    const color = "iPhone 15 Pro 256GB Natural Titanium";
    world.verdicts[color] = verdict(color, "verified");
    const phone = await decideResearchTarget(color, deps(world));
    check("a phone color/capacity goes under the phone", phone.kind === "create_variant" && phone.parent.id === "iph", phone);
    const zelda = "Nintendo Switch OLED Zelda Edition";
    world.verdicts[zelda] = verdict(zelda, "verified");
    const edition = await decideResearchTarget(zelda, deps(world));
    check("a themed edition goes under the console", edition.kind === "create_variant" && edition.parent.id === "nsw", edition);
    const fresh = await decideResearchTarget("Zorblax Quantum Hub 7TB", deps(world));
    check("a product with no related entry is just a new product", fresh.kind === "create_product");
  }

  section("seller-invented and nonexistent names go through the same gate");
  {
    const invented = "Xbox Series X Diamond Gold Edition";
    const world: World = { tracked: [XBOX], verified: [], verdicts: { [invented]: verdict(invented, "unverified", "Only seller listings or unclassified pages (ebay.com) use this name. That shows sellers use the name, not that it is an official product.") } };
    const d = await decideResearchTarget(invented, deps(world));
    check("not filed as a product", d.kind === "not_recorded");
    check("the reason (only sellers use it) reaches the answer", d.kind === "not_recorded" && /seller listings/i.test(d.message), d);
    const ghost = await decideResearchTarget("Xbox Series X 99TB Rainbow Edition", deps({ tracked: [XBOX], verified: [], verdicts: {} }));
    check("a name nobody sells is not filed either", ghost.kind === "not_recorded");
  }

  section("conversation consistency: earlier findings are reused, a link triggers a new look, a thinner look never downgrades");
  {
    let checks = 0;
    let clock = NOW;
    const memory = createVerdictMemory();
    let persistedVerdict: VariantVerdict | null = null;
    const results: VariantVerdict[] = [verdict(GALAXY, "verified", "xbox.com lists it", NOW)];
    const verify = makeClaimVerifier({
      memory,
      persisted: () => persistedVerdict,
      check: async () => {
        checks++;
        return results.shift() ?? verdict(GALAXY, "unverified", "nothing found", clock);
      },
      now: () => clock,
    });
    const first = await verify(GALAXY, XBOX);
    check("first ask: one check, verified", first.status === "verified" && checks === 1);
    const second = await verify("xbox series x 2tb galaxy black special edition", XBOX);
    check("asked again (different casing): the earlier finding is reused, no second search", second.status === "verified" && checks === 1);
    clock += 3_600_000;
    const later = await verify(GALAXY, XBOX);
    check("an hour later it is still the same finding, not re-litigated", later.status === "verified" && checks === 1);
    const withLink = await verify(GALAXY, XBOX, ["https://www.xbox.com/en-us/consoles/xbox-series-x"]);
    check("a link from the user is new evidence: a new look", checks === 2);
    check("a thinner new look does not downgrade a verified product", withLink.status === "verified", withLink);

    const m2 = createVerdictMemory();
    let c2 = 0;
    const v2 = makeClaimVerifier({ memory: m2, persisted: () => null, check: async () => (c2++, verdict(GALAXY, "unverified", "nothing", clock)), now: () => clock });
    await v2(GALAXY, XBOX);
    await v2(GALAXY, XBOX);
    check("an unverified answer is not repeated immediately", c2 === 1);
    clock += 11 * 60_000;
    await v2(GALAXY, XBOX);
    check("but it is looked at again after a while", c2 === 2);

    persistedVerdict = verdict("Brand New Claim Edition", "supported", "saved earlier");
    const v3 = makeClaimVerifier({ memory: createVerdictMemory(), persisted: () => persistedVerdict, check: async () => { throw new Error("must not search"); }, now: () => clock });
    check("what the Database saved in an earlier session is reused", (await v3("Brand New Claim Edition", XBOX)).status === "supported");
  }

  section("a user's link is read when it is public, and never when it points at this computer or a private network");
  {
    check("a retailer link", isPublicHttpUrl("https://www.walmart.com/ip/Microsoft-Xbox-Series-X-2TB-Console-Galaxy-Black-Special-Edition/14579873332"));
    check("the manufacturer link", isPublicHttpUrl("https://www.xbox.com/en-us/consoles/xbox-series-x"));
    for (const bad of ["http://localhost:3000/x", "http://127.0.0.1/a", "http://192.168.1.10/router", "http://10.0.0.5/", "http://172.20.1.1/", "http://169.254.169.254/latest/meta-data", "file:///etc/passwd", "ftp://example.com/a", "http://[::1]/", "https://user:pw@example.com/", "http://intranet/page", "javascript:alert(1)", "http://printer.local/"]) {
      check(`refused: ${bad}`, !isPublicHttpUrl(bad));
    }
    const found = publicHttpUrls("here it is https://www.xbox.com/en-us/consoles/xbox-series-x, and http://127.0.0.1:8080/secret too");
    check("only the public one is picked from a message", found.length === 1 && found[0] === "https://www.xbox.com/en-us/consoles/xbox-series-x", found);
  }

  section("the page the user linked decides it when it names the product (the transcript's case)");
  {
    const xboxPage = "Xbox Series X – 1TB Carbon Black\nXbox Series X – 2TB Galaxy Black Special Edition\nXbox Series X – 2TB Digital Edition White";
    const web: VerifyDeps = {
      async search() {
        return [];
      },
      async fetchText(url) {
        return url.includes("xbox.com") ? xboxPage : null;
      },
    };
    const v = await verifyVariant(GALAXY, web, { userUrls: ["https://www.xbox.com/en-us/consoles/xbox-series-x"], maxSteps: 3 });
    check("verified from the linked manufacturer page alone", v.status === "verified", v);
    check("the linked page is classed as the manufacturer", classifySource("https://www.xbox.com/en-us/consoles/xbox-series-x", GALAXY) === "manufacturer");
  }
});
