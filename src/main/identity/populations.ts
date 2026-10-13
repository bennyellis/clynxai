// Mixed comp sets. A search for a generic name ("Xbox Wireless Controller") returns the Series pad, the 360 pad, the One pad, the Elite pad...
// Averaging them gives a number that fits none of them. Which words separate the products is not something to hard-code per category: it is
// visible in the data. A word is a SEPARATOR when the comps that contain it sell for clearly different money than the comps that don't (and both
// groups are big enough to mean something). The comp set is then split along its separators, and the part that matches what the target
// actually says is the exact market; when the target says nothing about any separator, the plain part (no separator words) is used and the
// result is marked approximate.
import { definingCodes } from "./codes.js";

export interface PricedComp {
  title: string;
  priceUsd: number;
}

export interface Population<T extends PricedComp> {
  // The separator words the comps of this population contain (empty = the plain one).
  with: string[];
  comps: T[];
  medianUsd: number;
}

export interface PopulationResult<T extends PricedComp> {
  separators: string[];
  populations: Array<Population<T>>;
  // The comps that form the market for the target.
  chosen: T[];
  // "exact": the target names its separators (or nothing separates); "approximate": the target is generic and the plain population stood in;
  // "unresolved": mixed and nothing can stand in (all comps are labelled variants).
  state: "exact" | "approximate" | "unresolved";
  note: string;
}

// Words that carry no product information whatever the product is (English function words and marketplace filler). Not a category list.
const NOISE = new Set(
  (
    "a an the and or with for of in on to at by from is it its this that these those new used like works working work great good excellent condition " +
    "open box boxed original genuine authentic official oem free shipping ship fast tested clean mint barely very nice lightly gently only no not " +
    "as are was be you your our sale sold lot bundle set pack authentic usa us fully functional functioning perfect"
  ).split(" ")
);

const MIN_RATIO = 1.3; // medians must differ by 30% or more
const MIN_GROUP = 2;
const MIN_COMPS = 6;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function wordSet(title: string, exclude: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const w of title.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ")) {
    if (w.length < 2 || NOISE.has(w) || exclude.has(w)) continue;
    out.add(w);
  }
  for (const c of definingCodes(title)) if (!exclude.has(c)) out.add(c);
  return out;
}

export function splitByPriceSeparators<T extends PricedComp>(comps: T[], targetText: string): PopulationResult<T> {
  const one = (note: string): PopulationResult<T> => ({
    separators: [],
    populations: comps.length ? [{ with: [], comps, medianUsd: median(comps.map((c) => c.priceUsd)) }] : [],
    chosen: comps,
    state: "exact",
    note,
  });
  if (comps.length < MIN_COMPS) return one("too few comps to tell whether the set mixes different products");

  const targetWords = wordSet(targetText, new Set());
  const sets = comps.map((c) => wordSet(c.title, new Set()));
  const separators: string[] = [];
  let groups: number[][] = [comps.map((_, i) => i)];

  // Greedily peel off the strongest separator inside the biggest group, up to 3 times.
  for (let round = 0; round < 3; round++) {
    groups.sort((a, b) => b.length - a.length);
    const group = groups[0];
    if (!group || group.length < MIN_COMPS) break;
    const counts = new Map<string, number>();
    for (const i of group) for (const w of sets[i]) counts.set(w, (counts.get(w) ?? 0) + 1);
    let best: { word: string; score: number } | null = null;
    for (const [word, n] of counts) {
      if (separators.includes(word) || n < MIN_GROUP || group.length - n < MIN_GROUP) continue;
      const withPrices = group.filter((i) => sets[i].has(word)).map((i) => comps[i].priceUsd);
      const withoutPrices = group.filter((i) => !sets[i].has(word)).map((i) => comps[i].priceUsd);
      const mw = median(withPrices);
      const mo = median(withoutPrices);
      if (mw <= 0 || mo <= 0) continue;
      const ratio = Math.max(mw, mo) / Math.min(mw, mo);
      if (ratio < MIN_RATIO) continue;
      const score = Math.log(ratio) * Math.sqrt(Math.min(n, group.length - n));
      if (!best || score > best.score) best = { word, score };
    }
    if (!best) break;
    separators.push(best.word);
    const w = best.word;
    groups = [...groups.slice(1), group.filter((i) => sets[i].has(w)), group.filter((i) => !sets[i].has(w))].filter((g) => g.length > 0);
  }
  if (separators.length === 0) return one("no word separates the prices: treated as one product");

  // Every comp's membership over the separators, grouped.
  const keyOf = (i: number) => separators.filter((s) => sets[i].has(s));
  const byKey = new Map<string, number[]>();
  for (let i = 0; i < comps.length; i++) {
    const k = keyOf(i).join("|");
    byKey.set(k, [...(byKey.get(k) ?? []), i]);
  }
  const populations: Array<Population<T>> = [...byKey.entries()].map(([k, idx]) => ({
    with: k ? k.split("|") : [],
    comps: idx.map((i) => comps[i]),
    medianUsd: median(idx.map((i) => comps[i].priceUsd)),
  }));

  // Describe each population by the words most of its comps share, minus the words every population shares (those do not tell them apart).
  const charWords = populations.map((p) => {
    const counts = new Map<string, number>();
    for (const c of p.comps) for (const w of wordSet(c.title, new Set())) counts.set(w, (counts.get(w) ?? 0) + 1);
    const need = p.comps.length <= 2 ? 1 : Math.ceil(p.comps.length * 0.6);
    return new Set([...counts].filter(([, n]) => n >= need).map(([w]) => w));
  });
  const shared = new Set([...charWords[0]].filter((w) => charWords.every((set) => set.has(w))));
  const distinguishing = charWords.map((set) => new Set([...set].filter((w) => !shared.has(w))));
  const overlap = distinguishing.map((set) => [...set].filter((w) => targetWords.has(w)));
  const bestOverlap = Math.max(...overlap.map((o) => o.length));
  if (bestOverlap > 0) {
    const winners = populations.filter((_, i) => overlap[i].length === bestOverlap);
    if (winners.length === 1) {
      const i = populations.indexOf(winners[0]);
      return { separators, populations, chosen: winners[0].comps, state: "exact", note: `the comps mix different products (${separators.join(", ")}); using the ones matching "${overlap[i].join(" ")}"` };
    }
    return { separators, populations, chosen: [], state: "unresolved", note: `the comps mix different products (${separators.join(", ")}) and more than one matches the name` };
  }
  // A generic target: it does not say which. The cheapest sizeable population stands in (a floor, never a blend), flagged approximate.
  const sizeable = populations.filter((p) => p.comps.length >= 3).sort((a, b) => a.medianUsd - b.medianUsd);
  if (sizeable.length > 0) {
    return { separators, populations, chosen: sizeable[0].comps, state: "approximate", note: `the comps mix different products (${separators.join(", ")}) and the name does not say which: using the cheapest group as a floor` };
  }
  return { separators, populations, chosen: [], state: "unresolved", note: `the comps mix different products (${separators.join(", ")}) and the name does not say which` };
}
