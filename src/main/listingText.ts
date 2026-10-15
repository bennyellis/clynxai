// What a Facebook listing page says about THIS listing, as opposed to what else is on the page. A listing page also carries "Related searches" and "Today's picks"
// (other sellers' cards: titles, prices, places). Reading the whole page as the listing's description let another seller's "PlayStation 5 as is for parts" cost an Xbox
// 75% of its value (61 of 265 opened pages in a real database were affected). Pure (no I/O).
//
// Boundary markers (measured on a real database: found on 264 of 265 stored pages): the listing's own text ends at the first of
//   "Send seller a message", "Related searches", "Today's picks".

export interface OwnText {
  /** The listing's own text. */
  text: string;
  /** Whether a boundary marker was found (false: the layout may have changed; `text` is then only the top of the page and is flagged as lower confidence). */
  cut: boolean;
  /** The marker that ended the text, if any. */
  marker: string | null;
  /** The page length before the cut, for diagnostics. */
  pageChars: number;
}

const MARKERS: Array<{ label: string; re: RegExp }> = [
  { label: "Send seller a message", re: /Send seller a message/i },
  { label: "Related searches", re: /Related searches/i },
  { label: "Today's picks", re: /Today.{0,3}s picks/i },
];

// When no marker exists (a layout change), only the top of the page is trusted as the listing's own text: the listing sits above everything else.
const FALLBACK_TOP_CHARS = 1500;

export function listingOwnText(pageText: string): OwnText {
  const page = String(pageText ?? "");
  let end = page.length;
  let marker: string | null = null;
  for (const m of MARKERS) {
    const hit = m.re.exec(page);
    if (hit && hit.index < end) {
      end = hit.index;
      marker = m.label;
    }
  }
  if (marker) return { text: page.slice(0, end), cut: true, marker, pageChars: page.length };
  return { text: page.slice(0, FALLBACK_TOP_CHARS), cut: false, marker: null, pageChars: page.length };
}

/** The condition Facebook states for the listing ("Condition\nUsed - like new"), or null. */
export function declaredCondition(ownText: string): string | null {
  const m = /(?:^|\n)\s*Condition\s*\n\s*([^\n]{2,60})/i.exec(ownText);
  return m ? m[1].trim() : null;
}

export interface DetailTextFields {
  description: string;
  shippingMentioned: boolean;
  hasOfficialShipping: boolean;
  mentionsEbay: boolean;
  /** The text the seller-signal and age readers should use. */
  ownBody: string;
  textProvenance: { cut: boolean; marker: string | null; ownChars: number; pageChars: number };
  declaredCondition: string | null;
}

/** Everything the scanner reads from a listing page's text, taken from the listing's own text (the whole page only when no boundary exists). */
export function detailTextFields(bodyText: string): DetailTextFields {
  const own = listingOwnText(bodyText);
  const ownBody = own.cut ? own.text : bodyText;
  const description = own.cut ? own.text.slice(0, 4000) : own.text;
  return {
    description,
    shippingMentioned: /\bship(ping|s)?\b|\bdelivery\b|\bmail(ed)?\b/i.test(description),
    hasOfficialShipping: /\bships for \$|\bestimated arrival\b|\bdoor drop[- ]?off\b/i.test(ownBody),
    mentionsEbay: /\bebay\b/i.test(ownBody),
    ownBody,
    textProvenance: { cut: own.cut, marker: own.marker, ownChars: own.text.length, pageChars: own.pageChars },
    declaredCondition: declaredCondition(own.text),
  };
}

/**
 * The text condition checks may read for a listing: the title plus the listing's own description. When the page had no boundary marker (a layout change) the description is
 * only "the top of the page", so condition wording is read from the title and the declared condition alone: no high-confidence negative conclusion from text that may not be the seller's.
 */
export function conditionTextOf(detail: { title: string; description: string; textProvenance?: { cut: boolean }; declaredCondition?: string | null }): string {
  if (detail.textProvenance && !detail.textProvenance.cut) return `${detail.title} ${detail.declaredCondition ?? ""}`;
  return `${detail.title} ${detail.description}`;
}
