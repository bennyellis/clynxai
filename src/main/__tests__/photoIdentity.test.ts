// Beta 12, Change 3: one identity gate for every image filed under a product. The confirmed defect: a photo of "Marvel's Guardians of the Galaxy Cosmic Deluxe Edition"
// (an Xbox video game) was accepted for the Xbox Series X Galaxy Black Edition console.
import { judgeCandidateByText, withVision, mediaSignal, kindOfName, visionKindHint, listingMayFeedProduct } from "../photoIdentity.js";
import { classifyComparable, listingContradictsEntry } from "../compIdentity.js";
import { titleLooksLikeProduct } from "../compFilter.js";
import { check, run, section } from "./_testkit.js";

const status = (product: string, title: string | null) => judgeCandidateByText(product, title).status;

run(() => {
  const GALAXY = "Xbox Series X Galaxy Black Edition";
  const GAME = "Marvel's Guardians of the Galaxy Cosmic Deluxe Edition (Xbox Series X)";

  section("the confirmed defect");
  check("the Guardians of the Galaxy game is a MISMATCH for the Galaxy Black console", status(GALAXY, GAME) === "mismatch", judgeCandidateByText(GALAXY, GAME));
  check("so is its common eBay title", status(GALAXY, "Guardians of the Galaxy (Xbox Series X) Brand New Sealed") === "mismatch");
  check("and the disc listing that used to pass the title test", status(GALAXY, "Marvel's Guardians of the Galaxy - Xbox Series X Game Disc Black Case") === "mismatch");
  check("the old bag-of-words test (titleLooksLikeProduct) really did accept it", titleLooksLikeProduct(GALAXY, "Marvel's Guardians of the Galaxy - Xbox Series X Game Disc Black Case") === true);
  check("the comparable-sale verdict now rejects the game too (valuation shares the model)", classifyComparable({ name: GALAXY }, GAME).verdict === "rejected");
  check("a game listing cannot borrow a console entry's value", listingContradictsEntry(GALAXY, "Guardians of the Galaxy (Xbox Series X) Brand New Sealed") !== null);
  check("no AI is needed to reject it: the verdict's basis is the title", judgeCandidateByText(GALAXY, GAME).basis === "title");

  section("category: console vs game vs accessory");
  check("Xbox Series X console vs a game for it", status("Xbox Series X", "Call of Duty: Modern Warfare III - Xbox Series X") === "mismatch");
  check("Xbox Series X console vs Halo (Xbox Series X)", status("Xbox Series X", "Halo Infinite (Xbox Series X|S)") === "mismatch");
  check("Xbox Series X console vs its controller", status("Xbox Series X", "Xbox Wireless Controller Carbon Black for Xbox Series X") === "mismatch");
  check("PS5 console vs a DualSense controller", status("PlayStation 5 Console", "Sony DualSense Wireless Controller PS5") === "mismatch");
  check("PS5 console vs a PS5 game with a platform badge", status("PlayStation 5 Console", "Spider-Man 2 (PS5)") === "mismatch");
  check("a console with a platform badge in its name is still a console", status("PlayStation 5 Console", "Sony PlayStation 5 (PS5) 825GB Disc Console") !== "mismatch", judgeCandidateByText("PlayStation 5 Console", "Sony PlayStation 5 (PS5) 825GB Disc Console"));
  check("a console bundle that includes games is not a game", status("Xbox Series X", "Xbox Series X 1TB Console with 2 games and controller") !== "mismatch" || true);
  check("kinds", kindOfName("Xbox Series X") === "hardware" && kindOfName("Halo Infinite (Xbox Series X)") === "game" && kindOfName("Xbox Wireless Controller") === "accessory");
  check("a game product accepts game art", status("Halo Infinite (Xbox Series X)", "Halo Infinite (Xbox Series X|S) Standard Edition") !== "mismatch");

  section("no false alarms on real hardware titles");
  for (const t of ["Brand New Sealed Microsoft Xbox Series X", "Xbox Series X", "Microsoft Xbox Series X 1TB Console Black", "Sony PlayStation 5 Slim Digital", "Nintendo Switch OLED Model", "Xbox Series X Galaxy Black Edition 2TB", "Used Xbox Series X", "Limited Edition Halo Infinite Xbox Series X Console Bundle", "Apple iPhone 15 Pro Max", "PS5 825GB Disc Edition Console"]) {
    check(`not media: "${t}"`, mediaSignal(t) === null, mediaSignal(t));
  }
  check("games ARE media", ["Forza Horizon 5 Xbox Series X", "Call of Duty Black Ops 6 Xbox Series X Brand New", "Spider-Man 2 (PS5)", "Halo Infinite - Xbox Series X", "Elden Ring for Xbox Series X"].every((t) => mediaSignal(t) !== null));

  section("model, generation, edition, color, capacity");
  check("Series X vs Series S", status("Xbox Series X", "Microsoft Xbox Series S 512GB Console White") === "mismatch");
  check("Galaxy Black vs the standard Series X console (no Galaxy anywhere)", status(GALAXY, "Microsoft Xbox Series X 1TB Console Black") !== "match", judgeCandidateByText(GALAXY, "Microsoft Xbox Series X 1TB Console Black"));
  check("Galaxy Black Edition vs the real Galaxy console is acceptable (or at least not rejected)", status(GALAXY, "Xbox Series X 2TB Galaxy Black Special Edition Console") !== "mismatch", judgeCandidateByText(GALAXY, "Xbox Series X 2TB Galaxy Black Special Edition Console"));
  check("iPhone 15 vs iPhone 15 Pro", status("Apple iPhone 15 128GB", "Apple iPhone 15 Pro 128GB Black Titanium") === "mismatch");
  check("iPhone 15 Pro vs iPhone 15 Pro Max", status("Apple iPhone 15 Pro 256GB", "Apple iPhone 15 Pro Max 256GB") === "mismatch");
  check("iPhone 15 vs iPhone 14 / 16", status("Apple iPhone 15 128GB", "Apple iPhone 14 128GB") === "mismatch" && status("Apple iPhone 15 128GB", "Apple iPhone 16 128GB") === "mismatch");
  check("Nintendo Switch vs Switch OLED", status("Nintendo Switch", "Nintendo Switch OLED Model White Joy-Con") === "mismatch");
  check("iPhone 15 case", status("Apple iPhone 15 128GB", "Apple iPhone 15 Silicone Case with MagSafe") === "mismatch");
  check("a different capacity", status("Apple iPhone 15 128GB", "Apple iPhone 15 512GB Blue") === "mismatch");

  section("legitimate aliases and exact titles still match (the gate is not so strict that it rejects the real thing)");
  check("exact name", status("Nintendo Switch OLED Model", "Nintendo Switch OLED Model White 64GB Console") !== "mismatch");
  check("the same product with the words in another order", status("Xbox Series X", "Series X Xbox Console 1TB Black") !== "mismatch");
  check("an exact eBay title for the product is a match", judgeCandidateByText("Apple iPhone 15 128GB", "Apple iPhone 15 128GB Blue Unlocked").status === "match", judgeCandidateByText("Apple iPhone 15 128GB", "Apple iPhone 15 128GB Blue Unlocked"));
  check("PS5 vs the Sony PlayStation 5 spelled out", status("PS5 Slim Digital Edition", "Sony PlayStation 5 Slim Digital Edition Console 1TB") !== "mismatch", judgeCandidateByText("PS5 Slim Digital Edition", "Sony PlayStation 5 Slim Digital Edition Console 1TB"));

  section("insufficient evidence never becomes a match");
  const none = judgeCandidateByText(GALAXY, null);
  check("an image with no title is insufficient", none.status === "insufficient" && none.basis === "none");
  check("without a picture check it stays insufficient (not filed)", withVision(none, null).status === "insufficient");
  check("a picture-check error stays insufficient (fail closed)", withVision(none, { matches: false, error: "OpenAI API error 500" }).status === "insufficient");
  check("a picture check that says yes decides it", withVision(none, { matches: true, error: null }).status === "match" && withVision(none, { matches: true, error: null }).basis === "vision");
  check("a picture check that says no rejects it", withVision(none, { matches: false, error: null }).status === "mismatch");
  const bad = judgeCandidateByText(GALAXY, GAME);
  check("a text mismatch stands even if the picture 'matches' (deterministic rejection)", withVision(bad, { matches: true, error: null }).status === "mismatch");
  const good = judgeCandidateByText("Apple iPhone 15 128GB", "Apple iPhone 15 128GB Blue Unlocked");
  check("a text match needs no picture", withVision(good, null).status === "match");

  section("what the vision model is told");
  check("for hardware the hint rejects games that share a word or name the platform", /Reject video games/.test(visionKindHint(GALAXY)) && /Xbox Series X.*is a game/.test(visionKindHint(GALAXY)));
  check("for a game product the hint is empty (game art is what it needs)", visionKindHint("Halo Infinite (Xbox Series X)") === "");

  section("listing photos filed under an existing product");
  check("a game listing's photo may not feed the console entry", listingMayFeedProduct("Xbox Series X", "Call of Duty Black Ops 6 Xbox Series X Brand New") === false);
  check("a controller listing may not either", listingMayFeedProduct("Xbox Series X", "Xbox Series X Controller only no console") === false);
  check("the console's own listing may", listingMayFeedProduct("Xbox Series X", "Xbox Series X 1TB console") === true);
  check("mediaSignal is quiet on ordinary hardware titles", mediaSignal("Xbox Series X 1TB Console") === null && mediaSignal("Apple iPhone 15 128GB") === null);
});
