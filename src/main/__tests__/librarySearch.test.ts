import { matchesLibrarySearch } from "../../renderer/src/lib/librarySearch.js";
import { check, run, section } from "./_testkit.js";

run(async () => {
  section("library search");
  const e = { name: "Xbox Series X Galaxy Edition", family: "Xbox > Consoles", aliases: ["Xbox Series X 2TB Galaxy Black Special Edition"] };
  check("words in any order, not only one run of letters", matchesLibrarySearch("galaxy xbox", e) && matchesLibrarySearch("series x galaxy", e));
  check("an old or official name finds it", matchesLibrarySearch("galaxy black special", e) && matchesLibrarySearch("2 TB galaxy", e));
  check("typing as you go works: a word's start is enough", matchesLibrarySearch("galax", e) && matchesLibrarySearch("xbo ser", e));
  check("the folder counts", matchesLibrarySearch("consoles galaxy", e));
  check("a word that is nowhere does not match, and the middle of a word is not a match", !matchesLibrarySearch("playstation", e) && !matchesLibrarySearch("alaxy", e));
  check("an empty search matches everything", matchesLibrarySearch("   ", e));
});
