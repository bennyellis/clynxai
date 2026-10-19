// P13 (Guardians audit, 2026-10-19): a GAME title can never pass for a CONSOLE entry, whatever shape its title has. Beta 12 only caught the bracketed shape
// ("Guardians of the Galaxy (Xbox Series X)"); a dash before "Brand New", "Factory Sealed", "Complete in Box", or a second platform slipped past mediaSignal
// and was scored EXACT as a photo and as a sold comparable. Real titles, pure code (no AI, no network).
import { judgeCandidateByText, mediaSignal, kindOfName } from "../photoIdentity.js";
import { classifyComparable } from "../compIdentity.js";
import { check, run, section } from "./_testkit.js";

const CONSOLES = ["Xbox Series X Galaxy Edition", "Xbox Series X Galaxy Black Edition", "Xbox Series X Starfield", "Xbox Series X Halo Infinite"];

// Game titles seen on eBay (the Guardians audit, TESTER's wrong photos), most of them in shapes the old test missed.
const GAME_TITLES = [
  "Guardians of the Galaxy (Xbox Series X) Brand New Sealed",
  "Marvel's Guardians of the Galaxy Cosmic Deluxe Edition Xbox Series X",
  "Guardians of the Galaxy Xbox Series X Brand New Factory Sealed",
  "Guardians of the Galaxy - Xbox Series X - Brand New",
  "Marvel Guardians of the Galaxy Cosmic Deluxe Edition Xbox Series X Complete in Box",
  "Starfield - Xbox Series X - Brand New",
  "Halo Infinite Xbox Series X Xbox One Brand New Factory Sealed",
  "Guardians of the Galaxy Xbox Series X CIB",
  "Guardians of the Galaxy | Xbox Series X | Sealed",
  "Starfield – Xbox Series X – Brand New Sealed",
  "Guardians of the Galaxy Xbox Series X Brand New Free Shipping",
  "Guardians of the Galaxy Xbox Series X Brand New Fast Shipping",
  "Guardians of the Galaxy Xbox Series X Brand New US Version",
  "Guardians of the Galaxy Xbox Series X Brand New in Plastic",
  "Cyberpunk 2077 Xbox Series X Brand New Sealed Fast Ship",
];

// KNOWN GAP (not asserted as rejected): ONE unfamiliar word before the platform and no dash. It is as likely a console's edition name ("Robot White Xbox Series S Brand New") as a
// game's, so title wording cannot decide it; the entry's kind from the identity card / the eBay category (D1/D3 of the audit) must. These must at least not be called a game by
// mediaSignal alone: wrongly rejecting a real special-edition console is worse than letting a game through to the later picture / category checks.
const LONE_WORD_TITLES = ["Starfield Xbox Series X Brand New Factory Sealed", "Starfield Xbox Series X Sealed", "Starfield Xbox Series X"];

// Real consoles / console bundles: none of these may read as a game.
const CONSOLE_TITLES = [
  "Xbox Series X",
  "Brand New Sealed Microsoft Xbox Series X",
  "Xbox Series X Brand New Factory Sealed",
  "Xbox Series X - Brand New",
  "Microsoft Xbox Series X - Black - Brand New",
  "Authentic Microsoft Xbox Series X Brand New Factory Sealed",
  "Xbox Series X Complete in Box",
  "Xbox Series X Console - Complete in Box",
  "Xbox Series X Digital Edition Brand New Sealed",
  "Xbox Series X 2TB Galaxy Black Special Edition Console",
  "Xbox Series X Galaxy Black Edition 2TB",
  "Limited Edition Halo Infinite Xbox Series X Console Bundle",
  "Xbox Series X Starfield Limited Edition Console Bundle",
  "Used Xbox Series X",
  // real special-edition consoles with ONE edition word before the platform (found by TESTER; the first version of this fix called them games)
  "Halo Xbox Series X Brand New",
  "Kinect Xbox Series X New",
  "Robot White Xbox Series S Brand New",
  "Daystar Xbox Series S Brand New",
  "Daystar Xbox Series S New",
  "Cosmic Xbox Series X Brand New",
  "Starfield Limited Edition Xbox Series X Brand New",
  "Modded Xbox Series X Brand New",
  "Rare Xbox Series X Brand New",
  "Rare Modded Xbox Series X New",
  "Galaxy Black Xbox Series X Brand New Sealed",
];

run(() => {
  section("every game shape is a game signal");
  for (const t of GAME_TITLES) check(`media signal: "${t}"`, mediaSignal(t) !== null, mediaSignal(t));

  section("no console title reads as a game");
  for (const t of CONSOLE_TITLES) check(`not media: "${t}"`, mediaSignal(t) === null, mediaSignal(t));

  section("the known gap is documented, not hidden");
  for (const t of LONE_WORD_TITLES) check(`lone-word title is left to the kind gate, not guessed from words: "${t}"`, mediaSignal(t) === null, mediaSignal(t));

  section("a game title is rejected for every console entry, as a photo and as a sold comparable");
  for (const product of CONSOLES) {
    for (const title of GAME_TITLES) {
      const photo = judgeCandidateByText(product, title);
      const comp = classifyComparable({ name: product }, title);
      check(`photo mismatch  [${product}] <- "${title}"`, photo.status === "mismatch", photo);
      check(`comp rejected   [${product}] <- "${title}"`, comp.verdict === "rejected", comp.verdict);
    }
  }

  section("the console's own titles are still not rejected as games");
  check("Galaxy Black Edition vs its real listing", judgeCandidateByText("Xbox Series X Galaxy Black Edition", "Xbox Series X 2TB Galaxy Black Special Edition Console").status !== "mismatch");
  check("Galaxy Black Edition vs a sealed listing with the edition", judgeCandidateByText("Xbox Series X Galaxy Black Edition", "Xbox Series X Galaxy Black Edition 2TB Brand New Factory Sealed").status !== "mismatch");
  check("plain Series X vs a brand new sealed listing", judgeCandidateByText("Xbox Series X", "Xbox Series X Brand New Factory Sealed").status !== "mismatch");
  check("plain Series X vs a dash listing", judgeCandidateByText("Xbox Series X", "Microsoft Xbox Series X - Black - Brand New").status !== "mismatch");

  section("a game entry still takes its own game titles");
  const game = "Starfield (Xbox Series X)";
  check("kind of a bracketed game name", kindOfName(game) === "game");
  check("a dash-shaped game title matches the game entry (not rejected as media)", judgeCandidateByText(game, "Starfield - Xbox Series X - Brand New").status !== "mismatch", judgeCandidateByText(game, "Starfield - Xbox Series X - Brand New"));
});
