// Library search: every word you type has to appear (in any order) in the entry's name, its other names (aliases) or its folder, so "series x xbox", "galaxy 2tb" and an old name all find it.
// Sizes are read the same way on both sides ("2 TB" = "2tb"). Pure.
const norm = (text: string): string =>
  String(text ?? "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/(\d+)\s*[-]?\s*(?:terabytes?|tb)\b/g, "$1tb")
    .replace(/(\d+)\s*[-]?\s*(?:gigabytes?|gb)\b/g, "$1gb")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export function matchesLibrarySearch(query: string, entry: { name: string; family?: string | null; aliases?: ReadonlyArray<string> }): boolean {
  const words = norm(query).split(" ").filter(Boolean);
  if (words.length === 0) return true;
  const haystack = ` ${norm([entry.name, entry.family ?? "", ...(entry.aliases ?? [])].join(" "))} `;
  // a word matches at the start of a word in the haystack ("galax" finds Galaxy), so typing as you go works
  return words.every((w) => haystack.includes(` ${w}`));
}
