// Model facts: what Clynx KNOWS about a product line, written down once, with where each fact came from (Phase 1 of the Beta 30 plan; the owner's statements are a valid source and win over
// anything learned). The naming engine (namingEngine.ts) reads these to give every product ONE simple name, to know which other names mean the same product (aliases), and to know which
// details are worth a separate entry because models that differ in them really sell differently. Pure data and lookups: no I/O.
//
// The rule behind it (owner, 2026-10-20): a detail is part of a product's NAME only when models that differ in it have a real price or function difference. Until sold data can measure the
// gap, the default name parts are storage, edition, model generation and disc / no-disc; colour is folded in unless the facts say otherwise.

export type FactSource = "owner" | "maker" | "ebay_specifics" | "catalogue" | "default";

export interface ModelFact {
  /** The one simple name this model goes by in the Library. */
  canonical: string;
  /** Every other name for it: old names, official names, how sellers type it. Matching these gives the canonical entry, so renaming never breaks matching or sync. */
  aliases: string[];
  /** The family entry above it ("Xbox Series X" above its models); the family itself is not priced. */
  parent?: string;
  /** What is true of this model, for display and checks: { disc: "disc", colour: "Black", capacity: "1TB" }. */
  attrs: Record<string, string>;
  source: FactSource;
}

export interface LineFact {
  key: string;
  /** The family / line name. */
  name: string;
  models: ModelFact[];
  /** Attributes that DO change the price for this line (so they stay in the name). Colour is folded unless it is listed here. */
  distinguishing?: string[];
  /** A line whose colours really sell differently (rare): keep colour in the name. */
  keepColour?: boolean;
  /** Plain-words tells that separate its models in photos, shown when Clynx has to ask (Phase 3). */
  tells?: string[];
  source: FactSource;
}

const owner = "owner" as const;

/** The owner-confirmed starting facts. Learned and edited facts are layered on top (store.ts, model_fact_overrides). */
export const SEED_LINES: LineFact[] = [
  {
    key: "xbox-series-x",
    name: "Xbox Series X",
    source: owner,
    distinguishing: ["disc", "edition", "capacity"],
    tells: ["the black one has a disc slot on the front; the white Digital one has none"],
    models: [
      {
        canonical: "Xbox Series X (Black)",
        parent: "Xbox Series X",
        source: owner,
        attrs: { disc: "disc", colour: "Black", capacity: "1TB" },
        aliases: ["Xbox Series X", "Xbox Series X 1TB", "Xbox Series X Console", "Xbox Series X Disc", "Xbox Series X Carbon Black", "Xbox Series X Black", "Xbox Series X 1TB Carbon Black", "Microsoft Xbox Series X", "Xbox Series X (1TB)", "Xbox Series X Console 1TB"],
      },
      {
        canonical: "Xbox Series X Digital (White)",
        parent: "Xbox Series X",
        source: owner,
        attrs: { disc: "digital", colour: "White", capacity: "1TB" },
        aliases: ["Xbox Series X Digital", "Xbox Series X Digital Edition", "Xbox Series X All-Digital", "Xbox Series X All Digital", "Xbox Series X Robot White", "Xbox Series X Digital 1TB", "Xbox Series X Digital White", "Xbox Series X White Digital", "Xbox Series X 1TB Digital Edition"],
      },
      {
        canonical: "Xbox Series X Galaxy Edition",
        parent: "Xbox Series X",
        source: owner,
        attrs: { disc: "disc", edition: "Galaxy", capacity: "2TB", colour: "Galaxy Black" },
        aliases: ["Xbox Series X Galaxy", "Xbox Series X 2TB Galaxy Black Special Edition", "Xbox Series X Galaxy Black Special Edition", "Xbox Series X Galaxy Black Limited Edition", "Xbox Series X 2TB Galaxy Edition", "Xbox Series X Galaxy Black", "Xbox Series X Galaxy Special Edition", "Xbox Series X 2TB Galaxy Black", "Xbox Series X Galaxy Limited Edition"],
      },
    ],
  },
  {
    key: "xbox-series-s",
    name: "Xbox Series S",
    source: owner,
    distinguishing: ["capacity", "colour", "edition"],
    models: [
      { canonical: "Xbox Series S (White, 512GB)", parent: "Xbox Series S", source: owner, attrs: { capacity: "512GB", colour: "White" }, aliases: ["Xbox Series S", "Xbox Series S 512GB", "Xbox Series S Robot White", "Xbox Series S White", "Xbox Series S Console", "Xbox Series S 512GB White", "Xbox Series S All-Digital", "Microsoft Xbox Series S"] },
      { canonical: "Xbox Series S (White, 1TB)", parent: "Xbox Series S", source: owner, attrs: { capacity: "1TB", colour: "White" }, aliases: ["Xbox Series S 1TB", "Xbox Series S 1TB White", "Xbox Series S Robot White 1TB"] },
      { canonical: "Xbox Series S (Black, 1TB)", parent: "Xbox Series S", source: owner, attrs: { capacity: "1TB", colour: "Black" }, aliases: ["Xbox Series S 1TB Black", "Xbox Series S 1TB Carbon Black", "Xbox Series S Black", "Xbox Series S Carbon Black", "Xbox Series S Black 1TB"] },
    ],
  },
  {
    // The Switch family: the OLED and other near-identical models sit under the parent "Nintendo Switch"; Switch 2 is a whole other product and Lite a different shape.
    key: "nintendo-switch",
    name: "Nintendo Switch",
    source: owner,
    distinguishing: ["generation"],
    models: [
      { canonical: "Nintendo Switch OLED", parent: "Nintendo Switch", source: owner, attrs: { generation: "OLED" }, aliases: ["Nintendo Switch OLED Model", "Switch OLED", "Nintendo Switch (OLED model)", "Nintendo Switch OLED White", "Nintendo Switch OLED Neon", "Nintendo Switch OLED 64GB"] },
    ],
  },
  { key: "nintendo-switch-lite", name: "Nintendo Switch Lite", source: owner, models: [{ canonical: "Nintendo Switch Lite", source: owner, attrs: {}, aliases: ["Switch Lite", "Nintendo Switch Lite Console"] }] },
  { key: "nintendo-switch-2", name: "Nintendo Switch 2", source: owner, models: [{ canonical: "Nintendo Switch 2", source: owner, attrs: { generation: "2" }, aliases: ["Switch 2", "Nintendo Switch 2 Console"] }] },
  {
    // The 3DS family under one parent.
    key: "nintendo-3ds",
    name: "Nintendo 3DS",
    source: owner,
    distinguishing: ["generation", "size"],
    models: [
      { canonical: "Nintendo 3DS", parent: "Nintendo 3DS", source: owner, attrs: {}, aliases: ["Nintendo 3DS Console"] },
      { canonical: "Nintendo 3DS XL", parent: "Nintendo 3DS", source: owner, attrs: { size: "XL" }, aliases: ["3DS XL", "Nintendo 3DS XL Console"] },
      { canonical: "New Nintendo 3DS", parent: "Nintendo 3DS", source: owner, attrs: { generation: "New" }, aliases: ["New 3DS", "New Nintendo 3DS Console"] },
      { canonical: "New Nintendo 3DS XL", parent: "Nintendo 3DS", source: owner, attrs: { generation: "New", size: "XL" }, aliases: ["New 3DS XL", "New Nintendo 3DS XL Console"] },
      { canonical: "Nintendo 2DS XL", parent: "Nintendo 3DS", source: owner, attrs: { size: "XL" }, aliases: ["New Nintendo 2DS XL", "2DS XL"] },
    ],
  },
  {
    // MacBook Air by chip generation. The model numbers (A-numbers) printed on the underside separate them when a listing gives no specs; they are from the maker's public identification list, not
    // confirmed by the owner, so the source is "default": correct them in the facts if one is wrong.
    key: "macbook-air",
    name: "MacBook Air",
    source: "default",
    distinguishing: ["generation", "capacity"],
    tells: ["the A-number printed on the underside names the chip generation", "M1 has the older flat case; M2 and M3 have the MagSafe charging port"],
    models: [
      { canonical: "MacBook Air M1 (2020)", parent: "MacBook Air", source: "default", attrs: { generation: "M1", codes: "A2337" }, aliases: ["MacBook Air M1", "MacBook Air 2020", "Apple MacBook Air M1", "MacBook Air 13 M1", "MacBook Air A2337"] },
      { canonical: "MacBook Air M2 (2022)", parent: "MacBook Air", source: "default", attrs: { generation: "M2", codes: "A2681" }, aliases: ["MacBook Air M2", "MacBook Air 2022", "Apple MacBook Air M2", "MacBook Air 13 M2", "MacBook Air A2681"] },
      { canonical: "MacBook Air M3 (2024)", parent: "MacBook Air", source: "default", attrs: { generation: "M3", codes: "A3113" }, aliases: ["MacBook Air M3", "MacBook Air 2024", "Apple MacBook Air M3", "MacBook Air 13 M3", "MacBook Air A3113"] },
    ],
  },
  // Lines whose colours do not move the price (the owner's examples): no models listed, the general rule folds colour.
  { key: "sony-wh-1000xm5", name: "Sony WH-1000XM5", source: owner, models: [] },
  { key: "kitchenaid-artisan", name: "KitchenAid Artisan", source: owner, models: [], tells: ["the Artisan is the tilt-head mixer; the bowl-lift Professional is a different product"] },
  { key: "dewalt-dcd771", name: "DeWalt DCD771", source: owner, models: [], distinguishing: ["kit"], tells: ["DCD771 is the drill alone; DCD771C2 includes two batteries and a charger"] },
  { key: "airpods-pro", name: "AirPods Pro", source: owner, models: [], distinguishing: ["generation"] },
];

// ---- colours: the lexicon used to fold a colour out of a name (multi-word names first)

export const COLOUR_PHRASES: string[] = [
  "carbon black", "shock blue", "pulse red", "electric volt", "robot white", "galaxy black", "midnight blue", "space gray", "space grey", "rose gold", "jet black", "matte black", "onyx black", "empire red", "contour silver", "cast iron black",
  "natural titanium", "blue titanium", "white titanium", "black titanium", "desert titanium", "silver", "black", "white", "red", "blue", "green", "yellow", "orange", "pink", "purple", "gray", "grey", "gold", "midnight", "starlight", "graphite", "teal", "navy", "beige", "cream", "brown", "bronze", "lavender", "coral",
];

const COLOUR_RE = new RegExp(`\\b(?:${[...COLOUR_PHRASES].sort((a, b) => b.length - a.length).map((c) => c.replace(/ /g, "\\s+")).join("|")})\\b`, "gi");
export const colourWordsIn = (text: string): string[] => [...text.matchAll(COLOUR_RE)].map((m) => m[0].replace(/\s+/g, " ").trim());
export const stripColours = (text: string): string => text.replace(COLOUR_RE, " ").replace(/\s+/g, " ").replace(/\(\s*\)/g, "").trim();

/** One key for a name: lower case, letters and digits, sizes written the same way ("2 TB" = "2tb"). */
export function nameKey(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/(\d+)\s*[-]?\s*(?:terabytes?|tb)\b/g, "$1tb")
    .replace(/(\d+)\s*[-]?\s*(?:gigabytes?|gb)\b/g, "$1gb")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface AliasHit {
  line: LineFact;
  model: ModelFact;
  /** "canonical" when the name IS the canonical one, "alias" when it was another name for it. */
  how: "canonical" | "alias";
}

/** Builds the lookup from names to models. A name that two models claim is left to the model that lists it as its CANONICAL name, else the first (seed order). */
export function buildAliasIndex(lines: ReadonlyArray<LineFact>): Map<string, AliasHit> {
  const index = new Map<string, AliasHit>();
  for (const line of lines) {
    for (const model of line.models) {
      const own = nameKey(model.canonical);
      index.set(own, { line, model, how: "canonical" });
    }
  }
  for (const line of lines) {
    for (const model of line.models) {
      for (const alias of model.aliases) {
        const k = nameKey(alias);
        if (!index.has(k)) index.set(k, { line, model, how: "alias" });
      }
    }
  }
  return index;
}

/** The facts in force: the seeds, with the owner's edits (a model's extra aliases, a corrected attribute) layered on top. */
export function applyOverrides(lines: ReadonlyArray<LineFact>, overrides: ReadonlyArray<{ canonical: string; addAliases?: string[]; attrs?: Record<string, string> }>): LineFact[] {
  return lines.map((line) => ({
    ...line,
    models: line.models.map((m) => {
      const o = overrides.filter((x) => nameKey(x.canonical) === nameKey(m.canonical));
      if (o.length === 0) return m;
      return { ...m, source: "owner" as const, aliases: [...new Set([...m.aliases, ...o.flatMap((x) => x.addAliases ?? [])])], attrs: Object.assign({}, m.attrs, ...o.map((x) => x.attrs ?? {})) };
    }),
  }));
}

/** The line whose name a (cleaned) name starts with, longest line name first ("Nintendo Switch Lite" before "Nintendo Switch"). */
export function lineFor(name: string, lines: ReadonlyArray<LineFact>): LineFact | null {
  const k = nameKey(name);
  const byLength = [...lines].sort((a, b) => nameKey(b.name).length - nameKey(a.name).length);
  return byLength.find((l) => k === nameKey(l.name) || k.startsWith(`${nameKey(l.name)} `)) ?? null;
}
