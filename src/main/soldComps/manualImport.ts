// ManualImportProvider: the owner's own research (a Terapeak / Seller Hub export, a paste from their own eBay searching) turned into sold comps. Compliant and works today: Clynx drives
// nothing, the person brings the data. Pure parsing here; the imported rows live in the sold_comps table (SoldCompsStore) and the provider searches them.
import { createHash } from "node:crypto";
import { DAY_MS, normEpid, normGtin, type ProviderResult, type SoldComp, type SoldCompsProvider, type SoldCompsQuery } from "./types.js";

export interface ImportResult {
  comps: SoldComp[];
  /** Lines that could not be used, with the reason, so nothing disappears silently. */
  skipped: Array<{ line: number; text: string; reason: string }>;
}

const HEADERS: Record<string, string[]> = {
  title: ["title", "item title", "listing title", "name", "item", "description"],
  price: ["price", "sold price", "sale price", "sold for", "item price", "avg sold price", "total price", "total", "amount"],
  date: ["date", "date last sold", "last sold", "sold date", "date sold", "end date", "ended", "sale date", "date of sale"],
  condition: ["condition", "item condition"],
  shipping: ["shipping", "shipping cost", "postage", "shipping price", "delivery"],
  quantity: ["qty", "quantity", "quantity sold", "sold qty"],
  id: ["id", "item id", "item number", "itemid", "listing id"],
  gtin: ["gtin", "upc", "ean"],
  epid: ["epid"],
  option: ["buying option", "format", "listing type", "type"],
};

const CURRENCY_CODES = /\b(USD|EUR|GBP|CAD|AUD|CHF|JPY)\b/i;

/**
 * "$1,099.00", "USD 12.50", "1099", "EUR 12,50", "1.099,00", "£950" -> the amount AND its currency (USD unless the cell says otherwise); null when there is no number. A single comma followed
 * by one or two digits is a decimal comma ("12,50"); a dot followed by exactly three digits and then a comma is a thousands dot ("1.099,00").
 */
export function parsePrice(text: string | undefined | null): { value: number; currency: string } | null {
  if (!text) return null;
  const compact = text.replace(/\s/g, "");
  const currency = /€/.test(compact) ? "EUR" : /£/.test(compact) ? "GBP" : (CURRENCY_CODES.exec(text)?.[1]?.toUpperCase() ?? "USD");
  let body = compact.replace(CURRENCY_CODES, "").replace(/[^\d.,-]/g, "");
  if (/^-?\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(body)) body = body.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d+,\d{1,2}$/.test(body)) body = body.replace(",", ".");
  else body = body.replace(/,/g, "");
  const m = /-?\d+(?:\.\d+)?/.exec(body);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n >= 0 ? { value: n, currency } : null;
}

/** The amount only (see parsePrice). */
export function parseMoney(text: string | undefined | null): number | null {
  return parsePrice(text)?.value ?? null;
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
  // a leading byte-order mark, and Excel's "sep=," line, are not data
  const lines = text.replace(/^﻿/, "").replace(/\r/g, "").split("\n");
  const comps: SoldComp[] = [];
  const skipped: ImportResult["skipped"] = [];
  const expiresAt = retentionDays === null ? null : now + retentionDays * DAY_MS;

  // The header is the first of the first ten non-blank lines that names a title column and a price column ("Sold Price (USD)" counts as "sold price"); preamble lines before it are skipped.
  const normHeader = (h: string) => h.toLowerCase().replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim();
  const candidates: number[] = [];
  for (let i = 0; i < lines.length && candidates.length < 10; i++) if (lines[i].trim() && !/^sep=/i.test(lines[i].trim())) candidates.push(i);
  if (candidates.length === 0) return { comps, skipped };
  let headerIdx = -1;
  let delim = ",";
  let header: string[] = [];
  let titleOnlyLine = -1;
  for (const i of candidates) {
    const d = lines[i].includes("\t") ? "\t" : lines[i].includes(";") && !lines[i].includes(",") ? ";" : ",";
    const cells = splitDelimited(lines[i], d).map(normHeader);
    const t = columnFor(cells, "title");
    const p = columnFor(cells, "price");
    if (t >= 0 && p >= 0) {
      headerIdx = i;
      delim = d;
      header = cells;
      break;
    }
    if (t >= 0 && titleOnlyLine < 0 && cells.length > 1) titleOnlyLine = i;
  }
  if (headerIdx < 0 && titleOnlyLine >= 0) {
    // there is clearly a header with a title column but no price column we know: stop and say so instead of guessing which column is the price
    skipped.push({ line: titleOnlyLine + 1, text: lines[titleOnlyLine].slice(0, 120), reason: "the header has a title column but no price column Clynx recognises (name it 'Price' or 'Sold price')" });
    return { comps, skipped };
  }
  const hasHeader = headerIdx >= 0;
  const titleCol = hasHeader ? columnFor(header, "title") : -1;
  const priceCol = hasHeader ? columnFor(header, "price") : -1;
  const col = (k: keyof typeof HEADERS) => (hasHeader ? columnFor(header, k) : -1);
  const firstData = hasHeader ? headerIdx + 1 : candidates[0];

  for (let n = firstData; n < lines.length; n++) {
    const raw = lines[n];
    if (!raw.trim() || /^sep=/i.test(raw.trim())) continue;
    let title = "";
    let price: { value: number; currency: string } | null = null;
    let cells: string[] = [];
    if (hasHeader) {
      cells = splitDelimited(raw, delim);
      title = cells[titleCol] ?? "";
      price = parsePrice(cells[priceCol]);
    } else {
      // Pasted lines "title ... price": the price must LOOK like a price (a $ sign, or two decimals, or a plain number that is not a year), never just the last number of the line.
      const m = /^(.*?)[\s,\t|-]+((?:[$€£]\s?)?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|(?:[$€£]\s?)?\d+(?:[.,]\d{1,2})?)\s*$/.exec(raw.trim());
      if (m) {
        const token = m[2];
        const priceShaped = /[$€£]/.test(token) || /[.,]\d{2}$/.test(token) || (!/^(19|20)\d{2}$/.test(token) && token.length <= 5);
        if (priceShaped) {
          title = m[1].trim();
          price = parsePrice(token);
        }
      }
    }
    if (!title) {
      skipped.push({ line: n + 1, text: raw.slice(0, 120), reason: "no title" });
      continue;
    }
    if (price === null || price.value <= 0) {
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
      id: sourceListingId ? `manual_import:${sourceListingId}` : `manual_import:${hashId([title, price.value, soldAt])}`,
      source: "manual_import",
      sourceListingId,
      title,
      soldPrice: price.value,
      currency: price.currency,
      soldAt,
      condition: get("condition") || null,
      shippingCost: parseMoney(get("shipping")),
      quantitySold: Number.isFinite(qty) && qty > 0 ? qty : null,
      buyingOption: get("option") || null,
      // a code is kept only when it is a real code: spreadsheets turn UPCs into "8.89842640816E+11" or "889842640816.0", which are dropped rather than stored corrupted
      gtin: normGtin(get("gtin")) ? get("gtin").replace(/\D/g, "") : null,
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
  /** The owner's imports change between asks (import, then research again): a day-old "none" must never hide them. */
  readonly cacheable = false;
  constructor(private readonly rows: () => SoldComp[]) {}

  async search(query: SoldCompsQuery): Promise<ProviderResult> {
    const all = this.rows();
    if (all.length === 0) return { comps: [], outcome: { kind: "none", detail: "nothing has been imported yet" } };
    const q = words(query.title);
    // Deliberately loose (most of the query's words): the matcher decides, and a row that says "Limited Edition" for a "Special Edition" query must still reach it.
    const need = q.length <= 2 ? q.length : Math.max(2, Math.ceil(q.length * 0.6));
    const hits = all.filter((c) => {
      if ((normGtin(query.gtin) && normGtin(c.gtin) === normGtin(query.gtin)) || (normEpid(query.epid) && normEpid(c.epid) === normEpid(query.epid))) return true;
      const have = new Set(words(c.title));
      return q.length > 0 && q.filter((w) => have.has(w)).length >= need;
    });
    const comps = query.limit ? hits.slice(0, query.limit) : hits;
    return comps.length > 0 ? { comps, outcome: { kind: "ok" } } : { comps: [], outcome: { kind: "none", detail: `${all.length} imported sales, none share enough words with "${query.title}"` } };
  }
}
