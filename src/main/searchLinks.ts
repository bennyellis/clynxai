// A link the user pastes may be a search-results page (Google, Bing, an eBay or Walmart search) and not a product page. Such a page cannot be read as evidence
// about a product (it is a list of other pages, usually built by script); what it does carry is what the user searched for.
const SEARCH_HOSTS: Array<{ host: RegExp; param: string }> = [
  { host: /(^|\.)google\.[a-z.]+$/, param: "q" },
  { host: /(^|\.)bing\.com$/, param: "q" },
  { host: /(^|\.)duckduckgo\.com$/, param: "q" },
  { host: /(^|\.)search\.yahoo\.com$/, param: "p" },
  { host: /(^|\.)ebay\.[a-z.]+$/, param: "_nkw" },
  { host: /(^|\.)amazon\.[a-z.]+$/, param: "k" },
  { host: /(^|\.)walmart\.com$/, param: "q" },
];

/** If `url` is a search-results page (not a product page), the words it searched for; otherwise null. */
export function queryFromSearchUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const spec = SEARCH_HOSTS.find((s) => s.host.test(u.hostname));
    if (!spec) return null;
    const q = u.searchParams.get(spec.param);
    const isSearchPath = /^\/(?:search|sch\/|s$|s\/|html|lite)/.test(u.pathname) || u.pathname === "/" || u.pathname === "";
    return isSearchPath && q && q.trim() ? q.trim().replace(/\s+/g, " ") : null;
  } catch {
    return null;
  }
}
