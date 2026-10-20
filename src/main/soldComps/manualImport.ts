// ManualImportProvider: the owner's own research (a Terapeak / Seller Hub export, a paste from their own eBay searching) turned into sold comps. Compliant and works today: Clynx drives
// nothing, the person brings the data. Pure parsing here; the imported rows live in the sold_comps table (SoldCompsStore) and the provider searches them.
import { createHash } from "node:crypto";
import { DAY_MS, normGtin, type ProviderResult, type SoldComp, type SoldCompsProvider, type SoldCompsQuery } from "./types.js";

export interface ImportResult {
  comps: SoldComp[];
  /** Lines that could not be used, with the reason, so nothing disappears silently. */
  skipped: Array<{ line: number; text: string; reason: string }>;
}

const HEADERS: Record<string, string[]> = {
  title: ["title", "item title", "listing title", "name", "item", "description"],
  price: ["price", "sold price", "sale price", "sold for", "item price", "avg sold price", "total", "amount"],
  date: ["date", "sold date", "date sold", "end date", "ended", "sale date", "date of sale"],
  condition: ["condition", "item condition"],
  shipping: ["shipping", "shipping cost", "postage", "shipping price", "delivery"],
  quantity: ["qty", "quantity", "quantity sold", "sold qty"],
  id: ["id", "item id", "item number", "itemid", "listing id"],
  gtin: ["gtin", "upc", "ean"],
  epid: ["epid"],
  option: ["buying option", "format", "listing type", "type"],
};

/** "$1,099.00", "USD 12.50", "1099" -> number; null when there is no number. */
export function parseMoney(text: string | undefined | null): number | null {
  if (!text) return null;
  const m = /(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)/.exec(text.replace(/\s/g, ""));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function parseSoldDate(text: string | undefined | null): number | null {
  if (!text || !text.trim()) return null;
  const t = Date.parse(text.trim());
  return Number.isFinite(t) ? t : null;
}

/** One CSV / TSV line into cells, honouring "quoted, cells" and doubled quotes. */
export function splitDelimited(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function columnFor(header: string[], key: keyof typeof HEADERS): number {
  for (const name of HEADERS[key]) {
    const i = header.findIndex((h) => h === name);
    if (i >= 0) return i;
  }
  return -1;
}

const hashId = (parts: Array<string | number | null>) => createHash("sha1").update(parts.map((p) => String(p ?? "")).join("|")).digest("hex").slice(0, 16);

/**
 * CSV / TSV with a header row (any order, common column names), or a plain paste of lines ending in a price ("Xbox Series X Galaxy Black ... $1,099.00"). Nothing is guessed about
 * the product: a row needs a title and a price, everything else is optional.
 */
export function parseSoldImport(text: string, now: number = Date.now(), retentionDays: number | null = null): ImportResult {
  const lines = text.replace(/\r/g, "").split("\n");
  const comps: SoldComp[] = [];
  const skipped: ImportResult["skipped"] = [];
  const firstIdx = lines.findIndex((l) => l.trim());
  if (firstIdx < 0) return { comps, skipped };
  const first = lines[firstIdx];
  const delim = first.includes("\t") ? "\t" : first.includes(";") && !first.includes(",") ? ";" : ",";
  const header = splitDelimited(first, delim).map((h) => h.toLowerCase());
  const titleCol = columnFor(header, "title");
  const priceCol = columnFor(header, "price");
  const hasHeader = titleCol >= 0 && priceCol >= 0;
  const col = (k: keyof typeof HEADERS) => (hasHeader ? columnFor(header, k) : -1);
  const expiresAt = retentionDays === null ? null : now + retentionDays * DAY_MS;

  for (let n = hasHeader ? firstIdx + 1 : firstIdx; n < lines.length; n++) {
    const raw = lines[n];
    if (!raw.trim()) continue;
    let title = "";
    let price: number | null = null;
    let cells: string[] = [];
    if (hasHeader) {
      cells = splitDelimited(raw, delim);
      title = cells[titleCol] ?? "";
      price = parseMoney(cells[priceCol]);
    } else {
      const m = /^(.*?)[\s,\t|-]+\$?\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*$/.exec(raw.trim());
      if (m) {
        title = m[1].trim();
        price = parseMoney(m[2]);
      }
    }
    if (!title) {
      skipped.push({ line: n + 1, text: raw.slice(0, 120), reason: "no title" });
      continue;
    }
    if (price === null || price <= 0) {
      skipped.push({ line: n + 1, text: raw.slice(0, 120), reason: "no usable price" });
      continue;
    }
    const get = (k: keyof typeof HEADERS) => {
      const c = col(k);
      return c >= 0 ? (cells[c] ?? "").trim() : "";
    };
    const soldAt = parseSoldDate(get("date"));
    const sourceListingId = get("id") || null;
    const qty = Number(get("quantity"));
    comps.push({
      id: sourceListingId ? `manual_import:${sourceListingId}` : `manual_import:${hashId([title, price, soldAt])}`,
      source: "manual_import",
      sourceListingId,
      title,
      soldPrice: price,
      currency: "USD",
      soldAt,
      condition: get("condition") || null,
      shippingCost: parseMoney(get("shipping")),
      quantitySold: Number.isFinite(qty) && qty > 0 ? qty : null,
      buyingOption: get("option") || null,
      gtin: get("gtin").replace(/\D/g, "") || null,
      epid: get("epid") || null,
      categoryId: null,
      imageUrl: null,
      seller: null,
      fetchedAt: now,
      expiresAt,
      raw: hasHeader ? Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""])) : { line: raw },
    });
  }
  return { comps, skipped };
}

/** Words that carry no meaning for "does this imported row belong to the search". */
const STOP = new Set(["the", "a", "an", "and", "or", "of", "for", "with", "w", "to", "in", "new", "used", "console", "edition"]);
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));

/**
 * Searches the owner's imported rows. `rows` is a function so the provider reads the current table; the search only narrows by words (a title must contain every word of the query that is
 * not filler, or share the GTIN / ePID): deciding whether a row IS the product is the matcher's job (match.ts), not this provider's.
 */
export class ManualImportProvider implements SoldCompsProvider {
  readonly id = "manual_import" as const;
  readonly label = "Your own imported sales";
  readonly thirdParty = false;
  constructor(private readonly rows: () => SoldComp[]) {}

  async search(query: SoldCompsQuery): Promise<ProviderResult> {
    const all = this.rows();
    if (all.length === 0) return { comps: [], outcome: { kind: "none", detail: "nothing has been imported yet" } };
    const q = words(query.title);
    // Deliberately loose (most of the query's words): the matcher decides, and a row that says "Limited Edition" for a "Special Edition" query must still reach it.
    const need = q.length <= 2 ? q.length : Math.max(2, Math.ceil(q.length * 0.6));
    const hits = all.filter((c) => {
      if ((normGtin(query.gtin) && normGtin(c.gtin) === normGtin(query.gtin)) || (query.epid && c.epid === query.epid)) return true;
      const have = new Set(words(c.title));
      return q.length > 0 && q.filter((w) => have.has(w)).length >= need;
    });
    const comps = query.limit ? hits.slice(0, query.limit) : hits;
    return comps.length > 0 ? { comps, outcome: { kind: "ok" } } : { comps: [], outcome: { kind: "none", detail: `${all.length} imported sales, none share enough words with "${query.title}"` } };
  }
}
