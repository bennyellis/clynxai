// Colors in product names and listing titles. Color is what separates a black Xbox Series S from a white one (they
// sell separately and look different), so it has to be handled in code wherever products are matched.

const COLOR_WORDS = new Set([
  "black", "white", "blue", "red", "green", "pink", "purple", "gray", "grey", "silver", "gold",
  "yellow", "orange", "brown", "beige", "cream", "teal", "navy", "graphite", "midnight", "starlight",
]);

function colorTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

/** The distinct colors a text names ("grey" and "gray" count as one). */
export function colorsIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const t of colorTokens(text)) if (COLOR_WORDS.has(t)) found.add(t === "grey" ? "gray" : t);
  return found;
}

export function isColorWord(word: string): boolean {
  return COLOR_WORDS.has(word.toLowerCase());
}

export function sameColors(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((c) => b.has(c));
}

/** True when both texts name colors and have none in common ("Black" vs "White"; "Black/White" shares both). */
export function colorsConflict(a: string, b: string): boolean {
  const ca = colorsIn(a);
  const cb = colorsIn(b);
  return ca.size > 0 && cb.size > 0 && ![...ca].some((c) => cb.has(c));
}
