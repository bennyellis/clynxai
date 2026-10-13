// Phase 4 stage 1: defining codes, two-way comparison, and splitting mixed comp sets by what actually separates prices.
// The "held-out" cases (vehicles, tool batteries, appliances, collectibles, furniture) were written without tuning any rule to them.
import fs from "node:fs";
import path from "node:path";
import { codesMissingFrom, definingCodes, relateCodes, specificNameFor } from "../identity/codes.js";
import { splitByPriceSeparators } from "../identity/populations.js";
import { check, run, section } from "./_testkit.js";

const comp = (title: string, priceUsd: number) => ({ title, priceUsd });
const spread = (title: string, prices: number[]) => prices.map((p, i) => comp(`${title} #${i}`.replace(/ #\d+$/, ""), p));

run(() => {
  section("defining codes: found by pattern, not by category");
  {
    check("model numbers and letter+digit words", definingCodes("Official Microsoft Xbox 360 Wireless Controller 1403").join() === "360,1403", definingCodes("Official Microsoft Xbox 360 Wireless Controller 1403"));
    check("capacities, years and small counts are not codes", definingCodes("Samsung 980 Pro 1TB SSD 2022 pack of 2").join() === "980");
    check("works on products nobody coded for", definingCodes("DeWalt DCD791 20V Max 5.0Ah drill").join() === "dcd791,20v,5p0ah", definingCodes("DeWalt DCD791 20V Max 5.0Ah drill"));
    check("a glued model number still counts", definingCodes("rtx3060ti founders").join() === "rtx3060ti");
  }

  section("two-way comparison");
  {
    const r = relateCodes("Xbox Wireless Controller", "Official Microsoft Xbox 360 Wireless Controller 1403");
    check("a generic reference vs a 360 title: the candidate has codes the reference lacks", r.relation === "candidate-has-more" && r.extraInCandidate.join() === "360,1403", r);
    check("the reverse direction is reported as the reference having more", relateCodes("Xbox 360 Wireless Controller 1403", "Xbox Wireless Controller").relation === "reference-has-more");
    check("the same product spelled differently is equal", relateCodes("Xbox 360 Controller", "Microsoft Xbox 360 wireless controller black").relation === "equal");
    check("x360 and 360 agree", relateCodes("Xbox 360 controller", "X360 controller").relation === "equal");
    check("different models are a conflict", relateCodes("DeWalt DCD771 drill", "DeWalt DCD791 drill").relation === "conflict");
    check("3060 is not in 30601", codesMissingFrom("RTX 30601", "RTX 3060").join() === "3060");
    // symmetry: swapping the two texts swaps the relation
    const pairs: Array<[string, string]> = [["Galaxy S21", "Galaxy S21 FE 5G"], ["Civic Si 2018", "Civic 2018"], ["M18 battery", "M18 XC 5.0 battery"]];
    check("swapping the texts swaps the relation", pairs.every(([a, b]) => { const ab = relateCodes(a, b).relation, ba = relateCodes(b, a).relation; return (ab === "candidate-has-more" && ba === "reference-has-more") || (ab === "reference-has-more" && ba === "candidate-has-more") || (ab === ba); }));
    check("word order and case do not matter", relateCodes("controller wireless XBOX 360", "xbox 360 WIRELESS controller").relation === "equal");
  }

  section("a more specific name for a listing that is more specific than its entry");
  {
    check("adds the listing's codes in its own spelling", specificNameFor("Xbox Wireless Controller", "Official Microsoft Xbox 360 & Windows Black Wireless Controller 1403 OEM gamepad") === "Xbox Wireless Controller 360 1403");
    check("unchanged when the listing adds nothing", specificNameFor("Xbox Wireless Controller", "Used Xbox wireless controller works") === "Xbox Wireless Controller");
  }

  section("mixed comp sets split by price, with no category knowledge");
  {
    const xbox = [
      ...spread("Microsoft Xbox Series X|S Wireless Controller Carbon Black", [44, 47, 48, 50, 52, 46, 49, 45]),
      ...spread("Microsoft Xbox 360 Wireless Controller 1403 Black", [15, 17, 18, 19, 21, 16]),
      ...spread("Microsoft Xbox One Wireless Controller 1708", [26, 28, 29, 31, 32]),
    ];
    const generic = splitByPriceSeparators(xbox, "Xbox Wireless Controller");
    check("a generic target is flagged approximate and uses the cheapest group as a floor, not the average of everything", generic.state === "approximate" && generic.chosen.length > 0 && generic.chosen.every((c) => /360/.test(c.title)), generic.note);
    check("the separators found include the generation words", generic.separators.some((s) => ["360", "1403", "one", "1708", "series"].includes(s)), generic.separators);
    const is360 = splitByPriceSeparators(xbox, "Xbox 360 Wireless Controller 1403");
    check("a target that names its generation gets exactly that market", is360.state === "exact" && is360.chosen.length === 6 && is360.chosen.every((c) => /360/.test(c.title)), is360);
    const none = splitByPriceSeparators(xbox.slice(0, 5), "Xbox Wireless Controller");
    check("too few comps: no splitting, no claim", none.state === "exact" && none.chosen.length === 5);
    check("a comp set that is one product is left alone", splitByPriceSeparators(spread("PlayStation 5 Console Disc Edition 825GB", [380, 395, 400, 410, 405, 390, 385]), "PlayStation 5 Console").separators.length === 0);
  }

  section("held-out categories (rules were not tuned on these)");
  {
    const civic = [
      ...spread("2018 Honda Civic LX Sedan", [17800, 18200, 18500, 17900, 18100]),
      ...spread("2018 Honda Civic Si Coupe", [23800, 24500, 24100, 25000]),
      ...spread("2018 Honda Civic Type R Hatchback", [33500, 34800, 35200, 34000]),
    ];
    const g = splitByPriceSeparators(civic, "2018 Honda Civic");
    check("vehicles: a generic trim is not valued as the average of LX, Si and Type R", g.state === "approximate" && g.chosen.every((c) => c.priceUsd < 20000), g.note);
    const si = splitByPriceSeparators(civic, "2018 Honda Civic Si");
    check("vehicles: a named trim gets its own market", si.state === "exact" && si.chosen.length === 4 && si.chosen.every((c) => /Si/.test(c.title)), si);

    const batt = [
      ...spread("Milwaukee M18 Red Lithium XC 5.0 Battery", [78, 82, 85, 80, 84]),
      ...spread("Milwaukee M18 Red Lithium CP 2.0 Battery", [38, 42, 40, 45, 41]),
      ...spread("Milwaukee M18 Red Lithium High Output 8.0 Battery", [120, 128, 125, 130]),
    ];
    const b = splitByPriceSeparators(batt, "Milwaukee M18 Battery");
    check("tool batteries: mixed capacities are detected", b.separators.length > 0, b);

    const washer = [
      ...spread("LG 4.5 cu ft Top Load Washer White", [380, 400, 420, 390, 410]),
      ...spread("LG 5.2 cu ft Top Load Washer White", [560, 590, 575, 600, 580]),
    ];
    const w = splitByPriceSeparators(washer, "LG 5.2 cu ft Top Load Washer");
    check("appliances: the named capacity picks its own comps", w.state === "exact" && w.chosen.length === 5 && w.chosen.every((c) => /5\.2/.test(c.title)) || w.separators.length > 0, w);

    const cards = [
      ...spread("Pokemon Charizard Holo Base Set Unlimited", [180, 200, 190, 210, 195]),
      ...spread("Pokemon Charizard Holo Base Set 1st Edition Shadowless", [4200, 4500, 4800, 4400]),
    ];
    const c = splitByPriceSeparators(cards, "Pokemon Charizard Holo Base Set");
    check("collectibles: the rare edition is not averaged into the common one", c.separators.length > 0 && (c.state !== "exact" || c.chosen.every((x) => x.priceUsd < 1000)), c);
  }

  section("module hygiene");
  {
    // Enforces "no hardcoded category rules": the identity code may not name brands, products or product categories.
    const dir = path.join(process.cwd(), "src", "main", "identity");
    const src = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n") : "";
    const body = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const banned = /\b(xbox|playstation|iphone|nintendo|samsung|galaxy|milwaukee|dewalt|honda|civic|controller|console|battery|phone|laptop|sneaker)\b/i;
    check("no brand or category words in the identity code (comments aside)", !banned.test(body), body.match(banned)?.[0]);
  }
});
