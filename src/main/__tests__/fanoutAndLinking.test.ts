// Owner-approved fixes from the Beta 26 live test (L1-L3): one typed phrase must not fan out into ~120 AI calls and ten guessed products (L1), a failed research is a "needs retry" state and
// never description text (L2), and a verified edition goes under its base and takes the official name (L3). Fakes and a throwaway Database only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runVariantFanout, FANOUT_CAP_PER_PHRASE, type FanoutDeps } from "../variantFanout.js";
import { friendlyPriceCheckFailure, friendlyResearchFailure } from "../researchFailure.js";
import { isMoreSpecific } from "../variantIdentity.js";
import { adoptOfficialName, planParentLinks, cleanOfficialName } from "../variantLinking.js";
import { Store } from "../store.js";
import type { VariantVerdict } from "../variantEvidence.js";
import { check, run, section } from "./_testkit.js";

const NOW = 1_700_000_000_000;
const verdict = (claim: string, status: VariantVerdict["status"], extra: Partial<VariantVerdict> = {}): VariantVerdict => ({ claim, status, basis: "test", sources: [], matchedAttributes: [], missingAttributes: [], searched: ["q"], checkedAt: NOW, ...extra });

function fakeFanout(confirmed: string[], over: Partial<FanoutDeps> = {}) {
  const log = { verified: [] as string[], created: [] as string[], claims: [] as string[], slept: [] as number[], notes: [] as string[] };
  let t = 0;
  const deps: FanoutDeps = {
    alreadyTracked: () => false,
    verify: async (name) => (log.verified.push(name), verdict(name, confirmed.includes(name) ? "verified" : "unverified")),
    create: async (name) => void log.created.push(name),
    rememberClaim: (v) => void log.claims.push(v.claim),
    paused: () => false,
    sleep: async (ms) => void (log.slept.push(ms), (t += ms)),
    now: () => t,
    note: (m) => void log.notes.push(m),
    ...over,
  };
  return { deps, log };
}

run(async () => {
  section("L1 a suggestion from memory is only a candidate");
  const names = ["Xbox Series S", "Xbox Series X Robot White", "Xbox Series X Sport Green Controller Bundle", "Xbox Series X All-Digital Limited Edition (Retailer Exclusive)", "Xbox Series X Halo Infinite Limited Edition", "Xbox Series X Cyberpunk 2077 Limited Edition"];
  const a = fakeFanout(["Xbox Series S"]);
  const ra = await runVariantFanout(names, a.deps);
  check("at most the cap is even examined (a fan-out of 6 is 3)", a.log.verified.length === FANOUT_CAP_PER_PHRASE && ra.skipped.length === names.length - FANOUT_CAP_PER_PHRASE, { verified: a.log.verified.length, ra });
  check("only the confirmed one becomes a product", ra.created.length === 1 && a.log.created[0] === "Xbox Series S", ra);
  check("the unconfirmed ones are kept as claims on the base product, never filed", ra.unverified.length === 2 && a.log.claims.length === 2 && !a.log.created.includes("Xbox Series X Robot White"));
  const b = fakeFanout([]);
  const rb = await runVariantFanout(names, b.deps);
  check("nothing confirmed -> nothing created, however many names the model gave", rb.created.length === 0 && b.log.created.length === 0);
  const c = fakeFanout(names);
  await runVariantFanout(["Xbox Series S", "Xbox Series S", "xbox series s", "  Xbox Series S  "], c.deps);
  check("duplicates are examined once", c.log.verified.length === 1, c.log.verified);
  const d = fakeFanout(names, { alreadyTracked: (n) => /series s/i.test(n) });
  const rd = await runVariantFanout(["Xbox Series S", "Xbox Series X Robot White"], d.deps);
  check("a product already in the Database is skipped, not researched again", rd.skipped.includes("Xbox Series S") && d.log.verified.length === 1);

  section("L1 only a more specific version of the product is a candidate (the live Canon test)");
  const canon = ["Canon EOS R6", "Canon EOS R5", "Canon EOS R8", "Canon EOS R7", "Canon EOS R3", "Canon EOS R6 Mark II Body Only", "Canon EOS R6 Mark II Kit"];
  const keep = canon.filter((n) => isMoreSpecific(n, "Canon EOS R6 Mark II"));
  check("other Canon models are not versions of the R6 Mark II; a body-only version of it is (a 'kit' is just filler)", keep.join() === "Canon EOS R6 Mark II Body Only", keep);
  check("an iPhone Pro is a version of the iPhone", isMoreSpecific("iPhone 13 Pro", "iPhone 13") && !isMoreSpecific("iPhone 14", "iPhone 13"));

  section("an eBay / research failure reaches the person in one plain sentence (no browser flags)");
  const rawChromium = "browserType.launchPersistentContext: Timeout 180000ms exceeded. Call log: <launching> C:\\Program Files\\Google\\Chrome\\chrome.exe --disable-field-trial-config --disable-background-networking " + "--flag ".repeat(300);
  const friendlyEbay = friendlyPriceCheckFailure(rawChromium);
  check("a browser launch timeout becomes a short sentence that says the price was kept", friendlyEbay.length < 220 && !/chrome\.exe|--disable|Call log/.test(friendlyEbay) && /unchanged/.test(friendlyEbay), friendlyEbay);
  check("other price-check failures are plain too", [friendlyPriceCheckFailure("ETIMEDOUT"), friendlyPriceCheckFailure("Your AI access is paused for a while"), friendlyPriceCheckFailure("weird")].every((m) => m.length < 220 && /price/.test(m)));

  section("L1 spread out, two at a time, and it stops when the AI is paused");
  const e = fakeFanout(names);
  await runVariantFanout(names.slice(0, 3), e.deps);
  check("starts are spaced by the gap (nothing starts together)", e.log.slept.length >= 2 && e.log.slept.every((ms) => ms > 0 && ms <= 1500), e.log.slept);
  let active = 0;
  let peak = 0;
  const f = fakeFanout(names, {
    verify: async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return verdict(n, "verified");
    },
  });
  await runVariantFanout(names, f.deps, { gapMs: 0 });
  check("never more than two at once", peak <= 2, { peak });
  let calls = 0;
  const g = fakeFanout(names, { paused: () => ++calls > 1 });
  const rg = await runVariantFanout(names, g.deps, { gapMs: 0, concurrency: 1 });
  check("the run stops the moment the AI is paused, and says why", rg.stopped === "the AI is paused" && g.log.verified.length === 1, { rg, v: g.log.verified });
  const h = fakeFanout(names, { verify: async () => { throw new Error("boom"); } });
  const rh = await runVariantFanout(names.slice(0, 2), h.deps, { gapMs: 0 });
  check("one failing check does not stop the others or create anything", rh.created.length === 0 && rh.skipped.length === 2 && h.log.notes.length === 2);

  section("L2 a failed research is a state, never description text");
  for (const raw of ["Your AI access is paused for a while because of unusually heavy use. It resumes automatically.", "the web search was blocked or unreachable", "You have used today's AI allowance for your account.", "OpenAI credits are used up", "something odd"]) {
    const msg = friendlyResearchFailure(raw);
    check(`"${raw.slice(0, 40)}..." becomes one plain sentence with no raw text`, !msg.includes("Research failed") && !msg.includes(raw) && /try/i.test(msg) && msg.length < 140, msg);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-l2-"));
  const store = new Store(path.join(dir, "scout.db"));
  const id = store.addProductStub("p1", "Xbox Series S");
  store.updateProductProfile("p1", { aiSummary: "A good summary.", category: "Video Games & Consoles", family: "Video Games & Consoles > Xbox", familyLogoUrl: null, imageUrl: null });
  store.markResearchFailed(id, "The web search was blocked.", 1_000_000);
  const p = store.getProductById(id)!;
  check("the description, category and place are untouched by a failure", p.aiSummary === "A good summary." && p.category === "Video Games & Consoles" && p.family === "Video Games & Consoles > Xbox", p);
  check("it is marked failed with a plain note", p.researchState === "failed" && p.researchNote === "The web search was blocked.");
  check("not due yet, then due after the first wait", store.listResearchRetriesDue(1_000_000 + 60_000).length === 0 && store.listResearchRetriesDue(1_000_000 + 11 * 60_000).length === 1);
  store.markResearchFailed(id, "again", 2_000_000);
  check("the wait grows with each failure (30 minutes next)", store.listResearchRetriesDue(2_000_000 + 20 * 60_000).length === 0 && store.listResearchRetriesDue(2_000_000 + 31 * 60_000).length === 1);
  store.markResearchFailed(id, "again", 3_000_000);
  store.markResearchFailed(id, "again", 4_000_000);
  store.markResearchFailed(id, "again", 5_000_000);
  check("after four tries Clynx leaves it alone", store.listResearchRetriesDue(5_000_000 + 24 * 3600_000).length === 0);
  store.markResearchFailed(id, "The web search was blocked. I'll try this one again by myself.", 6_000_000);
  const stopped = store.getProductById(id)!.researchNote ?? "";
  check("and the note no longer promises a retry that will not happen", !/try this one again by myself/.test(stopped) && /press Research/i.test(stopped), stopped);
  check("a rejected API key says it will not fix itself", /will not fix itself/.test(friendlyResearchFailure("401 Incorrect API key provided")) && !/by myself/.test(friendlyResearchFailure("401 Incorrect API key provided")));
  store.setResearchState(id, null);
  check("a normal research clears the failure", store.getProductById(id)!.researchState === null);
  store.setResearchState(id, "unsourced", "No web pages were read.");
  check("a write-up from memory is marked unsourced", store.getProductById(id)!.researchState === "unsourced");
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp cleanup can fail on Windows */
  }

  section("L3 a verified edition goes under its base and takes the official name");
  const official = "XBOX Series X 2TB Galaxy Black Special Edition";
  check("the official name is adopted when it holds every word that was typed", adoptOfficialName("Xbox Series X Galaxy Edition", official, false, () => false) === official, adoptOfficialName("Xbox Series X Galaxy Edition", official, false, () => false));
  check("not when the person named it themself", adoptOfficialName("Xbox Series X Galaxy Edition", official, true, () => false) === null);
  check("not when another product already has that name", adoptOfficialName("Xbox Series X Galaxy Edition", official, false, (n) => n === official) === null);
  check("not when it is the same name", adoptOfficialName("Xbox Series X 2TB Galaxy Black Special Edition", official, false, () => false) === null);
  const caption = "Back panel of XBOX Series X 2TB Galaxy Black Special Edition";
  check("TESTER's live caption is not a name (it holds every word but opens with 'Back panel of')", adoptOfficialName("Xbox Series X Galaxy Edition", caption, false, () => false) === null && cleanOfficialName(caption, "Xbox Series X Galaxy Edition") === null);
  check("other captions and fragments are not names", ["Photo of XBOX Series X 2TB Galaxy Black Special Edition", "Xbox Series X Galaxy Edition photo of the console", "Xbox Series X Galaxy Edition - see more", "Xbox Series X Galaxy Edition front view"].every((c) => cleanOfficialName(c, "Xbox Series X Galaxy Edition") === null));
  check("a MAKER's name in front is the normal case and is accepted (F5)", cleanOfficialName("Microsoft Xbox Series X Galaxy Edition", "Xbox Series X Galaxy Edition") === "Microsoft Xbox Series X Galaxy Edition" && cleanOfficialName("Apple iPhone 15 Pro Max", "iphone 15 pro max") === "Apple iPhone 15 Pro Max" && cleanOfficialName("Valve Steam Deck OLED", "steam deck oled") === "Valve Steam Deck OLED");
  check("a different opening word that is NOT a maker is still refused", cleanOfficialName("Back panel of Xbox Series X Galaxy Edition", "Xbox Series X Galaxy Edition") === null && cleanOfficialName("Best Xbox Series X Galaxy Edition deals", "Xbox Series X Galaxy Edition") === null);
  check("a page title's site is cut off the name: '| xbox.com', '- Wikipedia', '- Microsoft Store'", ["Xbox Series X 2TB Galaxy Black Special Edition | xbox.com", "Xbox Series X 2TB Galaxy Black Special Edition - Wikipedia", "Xbox Series X 2TB Galaxy Black Special Edition - Microsoft Store"].every((n) => cleanOfficialName(n, "Xbox Series X Galaxy Edition") === "Xbox Series X 2TB Galaxy Black Special Edition"));
  check("a page ABOUT the product is not its name: review, specs, photo, gallery, box art, vs", ["Xbox Series X Galaxy Edition review", "Xbox Series X Galaxy Edition Specs", "Xbox Series X Galaxy Edition photo", "Xbox Series X Galaxy Edition gallery image 3 of 5", "Xbox Series X Galaxy Edition box art", "Xbox Series X Galaxy Edition vs Series S"].every((n) => cleanOfficialName(n, "Xbox Series X Galaxy Edition") === null));
  check("a typed claim that itself says 'review' is not penalised for it", cleanOfficialName("Xbox Series X Galaxy Edition review", "Xbox Series X Galaxy Edition review") !== null);
  check("the real official name still opens the same way and is adopted", cleanOfficialName(official, "Xbox Series X Galaxy Edition") === official);
  check("not a caption",cleanOfficialName("Buy now - free shipping - Xbox Series X Galaxy Edition on sale today only while stocks last at the best price online", "Xbox Series X Galaxy Edition") === null);
  const rows = [
    { id: "gal", name: "Xbox Series X Galaxy Edition", parentId: null as string | null, evidenceStatus: "verified" as string | null },
    { id: "plain", name: "Xbox Series X", parentId: null as string | null, evidenceStatus: null as string | null },
    { id: "s", name: "Xbox Series S", parentId: null as string | null, evidenceStatus: "verified" as string | null },
    { id: "ctl", name: "Xbox Series X Wireless Controller", parentId: null as string | null, evidenceStatus: "verified" as string | null },
  ];
  const plan = planParentLinks(rows);
  check("the plain console created AFTER the edition still picks it up", plan.some((l) => l.childId === "gal" && l.parentId === "plain"), plan);
  check("a different console is not linked under it", !plan.some((l) => l.childId === "s"), plan);
  check("an accessory is not a version of the console", !plan.some((l) => l.childId === "ctl"), plan);
  check("an unconfirmed edition is never linked", planParentLinks([{ ...rows[0], evidenceStatus: "unverified" }, rows[1]]).length === 0);
  check("one that already has a parent is left alone", planParentLinks([{ ...rows[0], parentId: "other" }, rows[1]]).length === 0);
});
