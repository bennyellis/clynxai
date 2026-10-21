// Phase 3 on a SCAN: fixture listings through the identity step and the deal gate, with fake values and fake rungs (no photos, no network).
import { assessListingIdentity, candidatesFor } from "../scanIdentity.js";
import { newLadderState } from "../identityLadder.js";
import { namingFacts } from "../namingEngine.js";
import { qualifyListing } from "../dealGate.js";
import { check, run, section } from "./_testkit.js";

const VALUES: Record<string, number> = {
  "Xbox Series X (Black)": 400, "Xbox Series X Digital (White)": 300, "Xbox Series X Galaxy Edition": 650,
  "iPhone 15 Pro Unlocked (256GB)": 800, "iPhone 15 Pro Locked (256GB)": 620,
};
const deps = (extra: Record<string, unknown> = {}) => ({
  valueOf: (n: string) => VALUES[n] ?? null,
  isDeal: (ask: number, value: number) => (value * 84) / 100 - ask >= (ask * 20) / 100,
  state: newLadderState(),
  ...extra,
});
const L = (id: string, title: string, priceUsd: number, description: string | null = null) => ({ id, title, description, priceUsd, evidenceKey: id });

run(async () => {
  const facts = namingFacts();
  section("what could it be?");
  check("'Xbox Series X' alone could be any of its priced models", candidatesFor("Xbox Series X", (n) => VALUES[n] ?? null, facts)?.candidates.length === 3);
  check("a title that names the model has nothing undecided", candidatesFor("Xbox Series X Digital Edition", (n) => VALUES[n] ?? null, facts) === null);
  check("an iPhone with no lock state could be Unlocked or Locked", candidatesFor("iPhone 15 Pro 256GB great shape", (n) => VALUES[n] ?? null, facts)?.candidates.map((c) => c.name).join() === "iPhone 15 Pro Unlocked (256GB),iPhone 15 Pro Locked (256GB)");
  check("a normal product has nothing undecided", candidatesFor("Dyson V8 Absolute", () => null, facts) === null);

  section("phone fixtures: unlocked, T-Mobile locked, iCloud locked -> three different outcomes");
  const unl = await assessListingIdentity(L("p1", "iPhone 15 Pro 256GB factory unlocked", 400), deps());
  check("unlocked: nothing undecided, nothing to hold back", unl.unconfirmed.length === 0 && unl.forParts === null);
  const tmo = await assessListingIdentity(L("p2", "iPhone 15 Pro 256GB T-Mobile locked", 400), deps());
  check("T-Mobile locked: nothing undecided either (its own entry)", tmo.unconfirmed.length === 0 && tmo.forParts === null);
  const icl = await assessListingIdentity(L("p3", "iPhone 15 Pro 256GB iCloud locked, selling for parts", 150), deps());
  check("iCloud locked: For Parts, held back from any alert", icl.forParts !== null && icl.unconfirmed.length > 0 && /For Parts/.test(icl.marker), icl);
  const vague = await assessListingIdentity(L("p4", "iPhone 15 Pro 256GB great shape", 600), deps());
  check("no lock information at $600: a deal for Unlocked but not for Locked, so it is held back and priced at the lower one", vague.unconfirmed.length > 0 && vague.valueUsd === 620 && /Vague|Likely/.test(vague.marker) && vague.resolution?.stop !== "settled", vague);
  const told = await assessListingIdentity(L("p5", "iPhone 15 Pro 256GB great shape", 450, "Works on all carriers, unlocked."), deps());
  check("the description settles it (rung 0 reads it) and it is let through at the Unlocked value", told.unconfirmed.length === 0 && told.valueUsd === 800 && told.resolution?.stop === "settled", told);

  section("console fixtures");
  const cheap = await assessListingIdentity(L("x1", "Xbox Series X", 200), deps());
  check("$200: a deal under every model, so no extra research, and (all values known) it is not held back", cheap.unconfirmed.length === 0 && cheap.resolution?.stop === "not_relevant" && cheap.resolution.stepsUsed === 0, cheap.resolution);
  const mid = await assessListingIdentity(L("x2", "Xbox Series X", 270), deps());
  check("$270: only a deal if it is the Black one, so it is held back and priced at the Digital value", mid.unconfirmed.length > 0 && mid.valueUsd === 300, mid);
  const named = await assessListingIdentity(L("x3", "Xbox Series X", 270, "This is the Digital Edition, white, no disc drive."), deps());
  check("the description says Digital Edition: settled at the Digital value", named.resolution?.identity.candidates[0]?.name === "Xbox Series X Digital (White)" && named.unconfirmed.length === 0, named);
  const unpriced = await assessListingIdentity(L("x4", "Xbox Series X", 270), deps({ valueOf: () => null }));
  check("with no values known the listing is handled as before (nothing to compare, nothing held back)", unpriced.unconfirmed.length === 0 && unpriced.resolution === null, unpriced);
  const oneKnown = await assessListingIdentity(L("x6", "Xbox Series X", 270), deps({ valueOf: (n: string) => (n === "Xbox Series X (Black)" ? 400 : null) }));
  check("with only one model priced there is nothing to tell apart either", oneKnown.unconfirmed.length === 0 && oneKnown.resolution === null);
  const close = await assessListingIdentity(L("x7", "Xbox Series X", 270), deps({ valueOf: (n: string) => (n === "Xbox Series X (Black)" ? 400 : n === "Xbox Series X Digital (White)" ? 380 : null) }));
  check("models priced within about 15% of each other cannot change the decision", close.unconfirmed.length === 0 && close.resolution === null);

  section("a photo rung, when the engine has one, settles it");
  let photoRan = 0;
  const viaPhoto = await assessListingIdentity(L("x5", "Xbox Series X", 270), deps({ extraRungs: { all_photos: async () => { photoRan++; return { candidates: [{ name: "Xbox Series X (Black)", valueUsd: 400 }], confidence: "settled" as const, found: "a disc slot is visible in photo 2" }; } } }));
  check("the disc slot makes it the Black model, a deal at $270, let through", photoRan === 1 && viaPhoto.unconfirmed.length === 0 && viaPhoto.valueUsd === 400, viaPhoto);

  section("the gate keeps an unsettled identity out of the deals");
  const gate = (identityVague: string[]) =>
    qualifyListing({
      pathway: "database", priceUsd: 270, shippingUsd: 0, conditionImpact: "none" as never, conditionAdjust: null, broken: false,
      evidence: { valueUsd: 400, basis: "sold", sampleSize: 12, ageDays: 3 } as never, identityUnconfirmed: [], identityVague, extras: null,
      age: { state: "fresh", text: "1 hour ago", hours: 1 } as never, aiFlagged: false, placeholderPrice: false,
      settings: { netPercent: 84, minMarginPercent: 20, maxCutPercent: 30 }, market: undefined,
    } as never);
  const settled = gate([]);
  const unsure = gate(["which model (disc or digital, size, edition)"]);
  check("settled: it qualifies", settled.qualified === true, settled.status);
  check("not settled: it is a 'worth a look' with the reason, never a deal", unsure.qualified === false && unsure.status === "worth_a_look" && unsure.reasons.some((r) => r.code === "IDENTITY_UNCONFIRMED" && /Not sure which model/.test(r.text)), unsure);

  section("MacBook Air with no specs (fixture d)");
  const MAC: Record<string, number> = { "MacBook Air M1 (2020)": 650, "MacBook Air M2 (2022)": 850, "MacBook Air M3 (2024)": 1000 };
  const macDeps = (extra: Record<string, unknown> = {}) => ({ ...deps({ valueOf: (n: string) => MAC[n] ?? null }), ...extra });
  check("the bare line could be any of its generations", candidatesFor("MacBook Air", (n) => MAC[n] ?? null, facts)?.candidates.length === 3);
  const calls: string[] = [];
  const mac = await assessListingIdentity(L("m1", "MacBook Air", 480), macDeps({ extraRungs: { all_photos: async (id: any) => { calls.push("photos"); return { candidates: id.candidates, confidence: "vague" as const, found: "no A-number visible", missing: id.missing }; }, labels_and_codes: async (id: any) => { calls.push("labels"); return { candidates: id.candidates, confidence: "vague" as const, found: "no label legible", missing: id.missing }; } } }));
  check("a deal for one generation and not another: held back (no alert), priced at the lowest value, and the ladder ran within its budget", mac.unconfirmed.length > 0 && mac.valueUsd === 650 && calls.join() === "photos,labels" && (mac.resolution?.stepsUsed ?? 99) <= 4, mac);
  check("the marker says what was tried", /Already tried/.test(mac.marker) && /A-number/.test(mac.marker), mac.marker);
  const sure = await assessListingIdentity(L("m2", "MacBook Air", 480), macDeps({ state: newLadderState(), extraRungs: { labels_and_codes: async () => ({ candidates: [{ name: "MacBook Air M1 (2020)", valueUsd: 650 }], confidence: "settled" as const, found: "the underside says A2337", missing: [] }) } }));
  check("an A-number read from a photo settles it as the M1", sure.unconfirmed.length === 0 && sure.valueUsd === 650);
  const everyDeal = await assessListingIdentity(L("m3", "MacBook Air", 300), macDeps({ state: newLadderState() }));
  check("a deal under every generation is not researched at all", everyDeal.resolution?.stop === "not_relevant" && everyDeal.resolution.stepsUsed === 0 && everyDeal.unconfirmed.length === 0);
});
