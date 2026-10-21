// Scanner parity S2: a console listed with a game becomes two things. Role of each extra item, and where the game is filed.
import { gameFamilyPath, itemRole, MAX_GAMES_PER_LISTING } from "../mixedListing.js";
import { check, run, section } from "./_testkit.js";

run(async () => {
  section("what each extra item is");
  const X = "Xbox Series X";
  check("'Titanfall 2' with an Xbox is a game", itemRole("Titanfall 2", X, "Xbox > Consoles") === "game");
  check("'Mario Kart 8 Deluxe' with a Switch is a game", itemRole("Mario Kart 8 Deluxe", "Nintendo Switch OLED", "Nintendo > Consoles") === "game");
  check("a platform badge makes it a game whatever the console", itemRole("Halo Infinite - Xbox Series X", X, null) === "game");
  check("controllers, cables, cases and headsets are accessories, not games", ["Extra controller", "Wireless Controller", "HDMI cable", "Carrying case", "Gaming headset", "Charging dock"].every((n) => itemRole(n, X, "Xbox > Consoles") === "accessory"));
  check("a second console, a list and vague words are not games", itemRole("Xbox Series S", X, "Xbox") === "other" && itemRole("Halo, Gears and Forza", X, "Xbox") === "other" && itemRole("some extras", X, "Xbox") === "other" && itemRole("lot of games", X, "Xbox") === "other");
  check("an unfamiliar title next to a thing that is not a game platform is not read as a game", itemRole("Cordless Vacuum Brush", "Dyson V8", "Home") === "other" && itemRole("Beautiful Title", "KitchenAid Artisan", null) === "other");
  section("where the game is filed");
  check("under the console's brand folder, in Games", gameFamilyPath("Xbox > Consoles") === "Xbox > Games" && gameFamilyPath("Xbox") === "Xbox > Games" && gameFamilyPath("Nintendo > Switch > Consoles") === "Nintendo > Switch > Games" && gameFamilyPath(null) === null && gameFamilyPath("") === null, [gameFamilyPath("Xbox > Consoles"), gameFamilyPath("Nintendo > Switch > Consoles")]);
  check("a lot is capped", MAX_GAMES_PER_LISTING === 5);

  section("Switch OLED + Mario Kart 8 + case (fixture c)");
  const parts = [["Mario Kart 8 Deluxe", "game"], ["Carrying case", "accessory"], ["Nintendo Switch Lite", "other"]] as const;
  check("the game becomes its own entry, the case stays a minor add-on, a second console is neither", parts.every(([n, role]) => itemRole(n, "Nintendo Switch OLED", "Nintendo > Consoles") === role), parts.map(([n]) => itemRole(n, "Nintendo Switch OLED", "Nintendo > Consoles")));
  check("it is filed with the Switch games, not in a flat list", gameFamilyPath("Nintendo > Consoles") === "Nintendo > Games");
  section("Xbox Series X with Titanfall 2 (fixture e)");
  check("two entries: the console stays, the game is a game", itemRole("Titanfall 2", "Xbox Series X", "Xbox > Consoles") === "game" && gameFamilyPath("Xbox > Consoles") === "Xbox > Games");
});
