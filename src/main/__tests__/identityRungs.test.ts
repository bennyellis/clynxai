// The photo, label and image-search rungs with FAKE eyes (no photos, no network), and through the whole scan identity step.
import { imageSearchRung, labelsRung, photoRung } from "../identityRungs.js";
import { assessListingIdentity } from "../scanIdentity.js";
import { newLadderState, type Identity } from "../identityLadder.js";
import { check, run, section } from "./_testkit.js";

const xbox: Identity = { candidates: [{ name: "Xbox Series X (Black)", valueUsd: 400 }, { name: "Xbox Series X Digital (White)", valueUsd: 300 }], confidence: "likely", missing: ["which model"], tried: [] };
const imgs = async () => ["data:image/png;base64,AA", "data:image/png;base64,BB"];

run(async () => {
  section("photos");
  const sure = await photoRung({ images: imgs, tellsFor: () => [], ask: async () => ({ pick: 0, confident: true, reason: "a disc slot is visible" }) })(xbox);
  check("a confident pick settles it on that candidate, with the reason", sure.confidence === "settled" && sure.candidates.length === 1 && sure.candidates[0].name === "Xbox Series X (Black)" && /disc slot/.test(sure.found));
  const lean = await photoRung({ images: imgs, tellsFor: () => [], ask: async () => ({ pick: 1, confident: false, reason: "looks white" }) })(xbox);
  check("an unsure pick changes nothing about the candidates", lean.candidates.length === 2 && lean.confidence === "likely" && /not sure/.test(lean.found));
  const nothing = await photoRung({ images: async () => [], tellsFor: () => [], ask: async () => ({ pick: 0, confident: true, reason: "x" }) })(xbox);
  check("no photos: nothing is asked or invented", nothing.candidates.length === 2 && /no photos/.test(nothing.found));
  const broken = await photoRung({ images: imgs, tellsFor: () => [], ask: async () => { throw new Error("down"); } })(xbox);
  check("a failing call is reported, never a guess", broken.candidates.length === 2 && /could not be read/.test(broken.found));
  const outOfRange = await photoRung({ images: imgs, tellsFor: () => [], ask: async () => ({ pick: 7, confident: true, reason: "x" }) })(xbox);
  check("a pick that is not one of the candidates is ignored", outOfRange.candidates.length === 2);

  section("labels and model numbers");
  const codes: Record<string, string[]> = { "Xbox Series X (Black)": ["1882"], "Xbox Series X Digital (White)": ["1998"] };
  const lab = await labelsRung({ images: imgs, codesFor: (n) => codes[n] ?? [], ask: async () => ["Model 1998", "1998"] })(xbox);
  check("a printed code that belongs to exactly one model settles it", lab.confidence === "settled" && lab.candidates[0].name === "Xbox Series X Digital (White)", lab);
  const unknown = await labelsRung({ images: imgs, codesFor: (n) => codes[n] ?? [], ask: async () => ["SN 12345"] })(xbox);
  check("a code Clynx does not know changes nothing and says what was read", unknown.candidates.length === 2 && /SN 12345/.test(unknown.found));
  const nocodes = await labelsRung({ images: imgs, codesFor: () => [], ask: async () => ["1998"] })(xbox);
  check("with no known codes (none are invented) it cannot settle", nocodes.candidates.length === 2);

  section("eBay image search votes");
  const title = (t: string, c: { name: string }[]) => (/digital/i.test(t) ? "Xbox Series X Digital (White)" : /series x/i.test(t) ? "Xbox Series X (Black)" : null) as string | null;
  const agree = await imageSearchRung({ images: imgs, matchTitle: title, ask: async () => ["Xbox Series X Digital Edition", "Xbox Series X All-Digital white", "Xbox Series X Digital 1TB", "Xbox Series X 1TB", "random"] })(xbox);
  check("enough agreeing results make it likely (not settled: it is a vote)", agree.confidence === "likely" && agree.candidates.length === 1 && agree.candidates[0].name === "Xbox Series X Digital (White)", agree);
  const split = await imageSearchRung({ images: imgs, matchTitle: title, ask: async () => ["Xbox Series X Digital", "Xbox Series X 1TB", "Xbox Series X Disc", "Xbox Series X Digital"] })(xbox);
  check("a split vote changes nothing", split.candidates.length === 2 && /split/.test(split.found));
  const none = await imageSearchRung({ images: imgs, matchTitle: title, ask: async () => null })(xbox);
  check("when the search is unavailable it says so", none.candidates.length === 2 && /not available/.test(none.found));

  section("through the scan identity step: the disc slot makes a $270 Series X a deal");
  const VALUES: Record<string, number> = { "Xbox Series X (Black)": 400, "Xbox Series X Digital (White)": 300, "Xbox Series X Galaxy Edition": 650 };
  const base = { valueOf: (n: string) => VALUES[n] ?? null, isDeal: (ask: number, v: number) => (v * 84) / 100 - ask >= (ask * 20) / 100, state: newLadderState() };
  const withoutPhotos = await assessListingIdentity({ id: "a", title: "Xbox Series X", description: null, priceUsd: 270, evidenceKey: "1" }, base);
  check("with only text it is held back", withoutPhotos.unconfirmed.length > 0);
  const withPhotos = await assessListingIdentity({ id: "b", title: "Xbox Series X", description: null, priceUsd: 270, evidenceKey: "1" }, { ...base, state: newLadderState(), extraRungs: { all_photos: photoRung({ images: imgs, tellsFor: () => [], ask: async () => ({ pick: 0, confident: true, reason: "disc slot" }) }) } });
  check("with the photo rung it is settled as the Black model and let through", withPhotos.unconfirmed.length === 0 && withPhotos.valueUsd === 400, withPhotos);
});
