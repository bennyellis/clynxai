// Chat edition research: the web here is a FAKE. These prove discovery, honest reporting and the "blocked" explanation, not that real sites say these things.
import { describeEditionResearch, editionQueries, researchEditions } from "../editionResearch.js";
import type { VerifyDeps } from "../variantEvidence.js";
import { check, run, section } from "./_testkit.js";

const CAT = "https://consolevariations.com/database/new-nintendo-3ds-xl";
const NIN = "https://www.nintendo.com/us/store/products/new-nintendo-3ds-xl/";
const PAGES: Record<string, string> = {
  [CAT]: "New Nintendo 3DS XL special editions: New Nintendo 3DS XL Galaxy Style, New Nintendo 3DS XL Pikachu Edition, New Nintendo 3DS XL Hyrule Edition and New Nintendo 3DS XL Majora's Mask Edition were released.",
  [NIN]: "The New Nintendo 3DS XL Pikachu Edition is a yellow handheld.",
};
function web(pages: Record<string, string>, blocked = false): VerifyDeps {
  let trace = { searches: [] as any[], pages: [] as any[] };
  return {
    async search(q) {
      trace.searches.push({ query: q, backend: "fake", outcome: blocked ? "blocked" : "ok", results: blocked ? 0 : Object.keys(pages).length, detail: blocked ? "captcha" : undefined });
      return blocked ? [] : Object.keys(pages).map((u) => ({ title: u, url: u, snippet: pages[u].slice(0, 60) }));
    },
    async fetchText(u) { return pages[u] ?? null; },
    trace: () => trace,
    reset: () => void (trace = { searches: [], pages: [] }),
  } as VerifyDeps;
}

run(async () => {
  section("edition research for chat");
  check("a named edition adds targeted queries", editionQueries("New Nintendo 3DS XL", "SNES").length === 5 && editionQueries("New Nintendo 3DS XL").length === 3);
  const r = await researchEditions("New Nintendo 3DS XL", web(PAGES));
  const names = r.findings.map((f) => f.name);
  check("every edition on a catalogue line is found", ["Galaxy Style", "Pikachu Edition", "Hyrule Edition"].every((n) => names.some((x) => x.includes(n))), names);
  const pika = r.findings.find((f) => f.name.includes("Pikachu"));
  check("one named by the maker is confirmed", pika?.support === "confirmed", pika);
  check("one on a single collector page is only reported", r.findings.find((f) => f.name.includes("Galaxy"))?.support === "reported");
  const t = describeEditionResearch(r);
  check("the answer lists editions and where", /Galaxy/.test(t) && /consolevariations/.test(t), t);
  const h = await researchEditions("New Nintendo 3DS XL", web(PAGES), { hint: "Galaxy" });
  check("a named edition is matched", (h.hint?.matches.length ?? 0) > 0);
  const n = await researchEditions("New Nintendo 3DS XL", web(PAGES), { hint: "SNES" });
  check("an edition no page mentions is reported as not mentioned", n.hint && n.hint.matches.length === 0 && !n.hint.mentionedAnywhere && /SNES/.test(describeEditionResearch(n)));
  const b = await researchEditions("New Nintendo 3DS XL", web({}, true));
  check("a blocked search says it was blocked", b.blocked && /captcha|block/i.test(describeEditionResearch(b)), describeEditionResearch(b));
});
