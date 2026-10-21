// Why a sold-price search came back with nothing, in plain words (backlog B3): "WatchCount's daily limit" says nothing about the market, "no sold items" does. Pure.
export type SoldPageState = "results" | "security_check" | "limit" | "empty" | "unknown";

/** What the WatchCount page was, from its address and visible text. */
export function classifySoldPage(url: string, bodyText: string, cardCount: number): SoldPageState {
  if (cardCount > 0) return "results";
  const text = String(bodyText ?? "").toLowerCase();
  const u = String(url ?? "").toLowerCase();
  if (/recaptcha|captcha|are you a robot|verify you are human|security check|unusual traffic/.test(text + " " + u)) return "security_check";
  if (/daily limit|search limit|limit (?:has been )?reached|exceeded|sign ?up or log ?in|log ?in to (?:continue|search)|upgrade/.test(text)) return "limit";
  if (/no (?:results|items|sold)|0 results|nothing found|did not match/.test(text)) return "empty";
  return "unknown";
}

/** The sentence for the product's activity feed when zero sold sales were read. `importedCount` is how many of the owner's own imported sales were also tried. */
export function explainZeroSold(state: SoldPageState | null, importedCount: number): string {
  const imports = importedCount > 0 ? "" : " You can also paste your own sold prices into Database > Needs review > Import sold prices.";
  switch (state) {
    case "security_check":
      return `WatchCount showed a security check instead of results, so no sales were read. That says nothing about whether this sells.${imports}`;
    case "limit":
      return `WatchCount's search limit was reached (anonymous use is capped; logging in raises it), so no sales were read. That says nothing about whether this sells.${imports}`;
    case "empty":
      return `WatchCount answered and found no sold listings for this search.${imports}`;
    case "results":
      return "WatchCount returned sales, but none passed the identity check for this exact product.";
    default:
      return `Nothing came back from WatchCount and it could not be told whether there are no sales or the page hid them, so this is not proof that nobody buys it.${imports}`;
  }
}
