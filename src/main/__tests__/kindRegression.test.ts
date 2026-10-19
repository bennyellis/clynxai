// P13 (Guardians audit, 2026-10-19): a GAME title can never pass for a CONSOLE entry, whatever shape its title has. Beta 12 only caught the bracketed shape
// ("Guardians of the Galaxy (Xbox Series X)"); a dash before "Brand New", "Factory Sealed", "Complete in Box", or a second platform slipped past mediaSignal
// and was scored EXACT as a photo and as a sold comparable. Real titles, pure code (no AI, no network).
import { judgeCandidateByText, mediaSignal, kindOfName, fileableWithoutPicture } from "../photoIdentity.js";
import { mediaAmbiguity } from "../productKind.js";
import { classifyComparable, usableForValuation } from "../compIdentity.js";
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

// AMBIGUOUS BY WORDS (owner rule: Clynx needs BOTH the listing's photos and its words): ONE unfamiliar word before the platform, no dash. "Halo Xbox Series X Brand New" is a special-edition
// console, the standalone game, or a seller's mistake: the words alone must never make it an exact match (no price, no photo filed) and must never reject it either; the photos decide.
const AMBIGUOUS_TITLES = [
  "Starfield Xbox Series X Brand New Factory Sealed", "Starfield Xbox Series X Sealed", "Starfield Xbox Series X", "STARFIELD XBOX SERIES X BRAND NEW",
  "Starfield Xbox Series X Brand New Free Shipping", "Starfield Xbox Series X Brand New Fast Shipping", "Starfield Xbox Series X Brand New US Version", "Starfield Xbox Series X Brand New in Plastic",
  "Starfield Xbox Series X Case Only", "Starfield/Xbox Series X/Brand New", "Halo Series X Brand New", "Starfield Series X Brand New", "Starfield, Xbox Series X, Brand New", "Halo Infinite Xbox One Series X Brand New".replace("Halo Infinite", "Halo"),
  "Halo Xbox Series X Brand New",
  "Kinect Xbox Series X New",
  "Robot White Xbox Series S Brand New",
  "Daystar Xbox Series S Brand New",
  "Daystar Xbox Series S New",
  "Cosmic Xbox Series X Brand New",
  "Starfield Limited Edition Xbox Series X Brand New",
  
  
];

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
  "Modded Xbox Series X Brand New",
  "Rare Xbox Series X Brand New",
  "Galaxy Black Xbox Series X Brand New Sealed",
];

run(() => {
  section("every game shape is a game signal");
  for (const t of GAME_TITLES) check(`media signal: "${t}"`, mediaSignal(t) !== null, mediaSignal(t));

  section("no console title reads as a game");
  for (const t of CONSOLE_TITLES) check(`not media: "${t}"`, mediaSignal(t) === null, mediaSignal(t));

  section("one unfamiliar word before the platform: neither a game nor an exact console; the photos decide");
  for (const t of AMBIGUOUS_TITLES) {
    check(`not called a game by words alone: "${t}"`, mediaSignal(t) === null, mediaSignal(t));
    check(`flagged as ambiguous: "${t}"`, mediaAmbiguity(t) !== null, mediaAmbiguity(t));
  }
  for (const product of ["Xbox Series X", "Xbox Series X Galaxy Black Edition", "Xbox Series X Starfield", "Xbox Series S Daystar"]) {
    for (const t of AMBIGUOUS_TITLES) {
      const photo = judgeCandidateByText(product, t);
      const comp = classifyComparable({ name: product }, t);
      check(`photo needs the picture, never a match  [${product}] <- "${t}"`, photo.status === "insufficient" || photo.status === "mismatch", photo);
      check(`not fileable without a picture check   [${product}] <- "${t}"`, !fileableWithoutPicture(photo), photo);
      check(`comp is never exact and never valued   [${product}] <- "${t}"`, comp.verdict !== "exact" && !usableForValuation(comp.verdict), comp.verdict);
    }
  }
  check("a bare Series X console title is not ambiguous", mediaAmbiguity("Series X Brand New") === null && mediaAmbiguity("Microsoft Series X Brand New") === null && mediaAmbiguity("Halo Series X 1TB Console") === null);
  check("a plain console title is not ambiguous", mediaAmbiguity("Xbox Series X Brand New") === null && mediaAmbiguity("Used Xbox Series X") === null && mediaAmbiguity("Rare Modded Xbox Series X New") === null && mediaAmbiguity("Galaxy Black Xbox Series X Brand New Sealed") === null);
  check("a console title with a model number or capacity is not ambiguous", mediaAmbiguity("Halo Xbox Series X 1TB Console") === null);


  section("other shapes TESTER found: platform first, bare Series X with two words, older platforms, spelling variants");
  const GAMES_TOO = ["Halo Infinite Series X Brand New", "Starfield for Series X", "Mario Kart Wii U Brand New", "Mario Kart 64 N64 Brand New", "Gran Turismo PSP Brand New", "Mario Kart Switch 2 Brand New", "Halo Infinite Xbox360 Brand New", "Super Mario World Super Nintendo Brand New"];
  for (const t of GAMES_TOO) check(`two-word title is a game: "${t}"`, mediaSignal(t) !== null, mediaSignal(t));
  const AMBIGUOUS_TOO = ["PS5 Spider-Man Brand New", "Switch Mario Kart Brand New", "Series X Halo Brand New", "Xbox One Halo Brand New", "Xbox Halo Brand New", "Xbox Series S Halo Brand New", "PlayStation 5 Spider-Man Brand New", "Steam Deck Halo Brand New", "Zelda N64 Brand New", "Zelda Gamecube Brand New", "Horizon PS-5 Brand New", "Halo Xbox360 Brand New", "Wii Mario Kart Brand New"];
  for (const t of AMBIGUOUS_TOO) {
    check(`not a game by words alone: "${t}"`, mediaSignal(t) === null, mediaSignal(t));
    check(`ambiguous: "${t}"`, mediaAmbiguity(t) !== null, mediaAmbiguity(t));
  }
  const STILL_CONSOLES = ["Nintendo Switch Neon Brand New", "Nintendo Switch Lite Turquoise Brand New", "Nintendo Switch Gray Brand New", "PS5 Slim Brand New", "PS5 Digital Edition Brand New Sealed", "PlayStation 5 Pro Brand New", "Xbox Series X Brand New", "Nintendo Switch OLED Model Brand New", "Xbox Series S Carbon Black Brand New", "PS5 DualSense Controller White"];
  for (const t of STILL_CONSOLES) check(`not ambiguous, not a game: "${t}"`, mediaSignal(t) === null && mediaAmbiguity(t) === null, { m: mediaSignal(t), a: mediaAmbiguity(t) });

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
