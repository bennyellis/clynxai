// Mixed galleries: which photos of a console entry are really a game, grouped and named. Titles only; nothing is moved.
import { gameNameFromTitle, proposeSplits } from "../gallerySplit.js";
import { check, run, section } from "./_testkit.js";

run(async () => {
  section("the game's name from a photo's title");
  check("platform and condition words come off", gameNameFromTitle("Titanfall 2 - Xbox One - Brand New") === "Titanfall 2" && gameNameFromTitle("Halo Infinite (Xbox Series X) Sealed") === "Halo Infinite" && gameNameFromTitle("Mario Kart 8 Deluxe - Nintendo Switch") === "Mario Kart 8 Deluxe", [gameNameFromTitle("Titanfall 2 - Xbox One - Brand New"), gameNameFromTitle("Halo Infinite (Xbox Series X) Sealed"), gameNameFromTitle("Mario Kart 8 Deluxe - Nintendo Switch")]);
  check("a title that is only a platform has no game name", gameNameFromTitle("Xbox Series X - Brand New") === null);

  section("proposals");
  const xbox = { id: "x", name: "Xbox Series X", family: "Xbox > Consoles", images: [
    { id: "i1", sourceTitle: "Microsoft Xbox Series X 1TB Console" },
    { id: "i2", sourceTitle: "Titanfall 2 - Xbox One - Brand New" },
    { id: "i3", sourceTitle: "Titanfall 2 Xbox One game case" },
    { id: "i4", sourceTitle: "Halo Infinite - Xbox Series X - Sealed" },
    { id: "i5", sourceTitle: null },
  ] };
  const p = proposeSplits(xbox);
  check("two games are found, each with its own photos, filed in the platform's Games folder", p.length === 2 && p.find((x) => x.name === "Titanfall 2")?.imageIds.join() === "i2,i3" && p.find((x) => x.name === "Halo Infinite")?.imageIds.join() === "i4" && p.every((x) => x.family === "Xbox > Games"), p);
  check("the console's own photos and untitled photos stay", !p.some((x) => x.imageIds.includes("i1") || x.imageIds.includes("i5")));
  check("each says why in plain words", p.every((x) => /titled as a game/.test(x.why)));
  check("a game entry is never split (only consoles are)", proposeSplits({ id: "g", name: "Titanfall 2 Xbox One game", family: "Xbox > Games", images: [{ id: "a", sourceTitle: "Halo - Xbox One" }] }).length === 0);
  check("a non-gaming product is never split", proposeSplits({ id: "d", name: "Dyson V8", family: "Home", images: [{ id: "a", sourceTitle: "Some Game - Xbox One" }] }).length === 0);
  check("nothing to propose for a clean gallery", proposeSplits({ ...xbox, images: [xbox.images[0]] }).length === 0);
});
