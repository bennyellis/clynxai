// Beta 12, Change 3 end to end: findReferencePhotos / findFreeReferencePhotos with a fake network. The Guardians of the Galaxy game never reaches a download or a vision
// call; an image with no title needs the picture check and is NOT filed when that check fails or says no.
import sharp from "sharp";
import { findFreeReferencePhotos, findReferencePhotos } from "../webResearch.js";
import { registerLowAiModeSource } from "../aiMode.js";
import { check, run, section } from "./_testkit.js";

process.env.OPENAI_API_KEY = "k";
const PRODUCT = "Xbox Series X Galaxy Black Edition";

async function pic(i: number): Promise<Buffer> {
  const w = 320;
  const data = Buffer.alloc(w * w * 3);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 3;
    const v = (x * (i + 2) + y * (7 - i) * (i % 2 === 0 ? 1 : -1) + i * 37) & 255;
    data[o] = v; data[o + 1] = (v * (i + 1)) & 255; data[o + 2] = (255 - v + i * 11) & 255;
  }
  return sharp(data, { raw: { width: w, height: w, channels: 3 } }).jpeg().toBuffer();
}

run(async () => {
  const downloads: string[] = [];
  const visionAnswers: Array<{ matches: boolean } | "error"> = [];
  let visionCalls = 0;
  const images: Record<string, Buffer> = {};
  for (let i = 0; i < 6; i++) images[`https://img.test/${i}.jpg`] = await pic(i);
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("openai.com")) {
      visionCalls++;
      const a = visionAnswers.shift() ?? { matches: false };
      if (a === "error") return new Response("boom", { status: 500 });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ matches: a.matches, reason: "x" }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (images[u]) {
      downloads.push(u);
      return new Response(new Uint8Array(images[u]), { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  const cands = [
    { url: "https://img.test/0.jpg", label: "eBay listing photo — Marvel's Guardians of the Galaxy Cosmic Deluxe Edition (Xbox Series X)", text: "Marvel's Guardians of the Galaxy Cosmic Deluxe Edition (Xbox Series X)" },
    { url: "https://img.test/1.jpg", label: "Stock photo — images.example.com" },
    { url: "https://img.test/2.jpg", label: "Stock photo — cdn.example.com" },
    { url: "https://img.test/3.jpg", label: "eBay listing photo — Xbox Series X 2TB Galaxy Black Special Edition Console", text: "Xbox Series X 2TB Galaxy Black Special Edition Console" },
    { url: "https://img.test/4.jpg", label: "eBay listing photo — Xbox Wireless Controller Galaxy Black", text: "Xbox Wireless Controller Galaxy Black" },
  ];

  section("AI mode: the game is rejected from its title alone; titleless images need the picture check");
  registerLowAiModeSource(() => false);
  visionAnswers.push({ matches: false }, { matches: true }, { matches: true });
  const r = await findReferencePhotos(PRODUCT, { want: 5, candidates: cands });
  check("the Guardians of the Galaxy game was never downloaded", !downloads.includes("https://img.test/0.jpg"), downloads);
  check("nor the controller", !downloads.includes("https://img.test/4.jpg"), downloads);
  check("2 rejected on their titles, no AI spent on them", r.rejectedByIdentity === 2, r.rejectedByIdentity);
  check("the vision check ran only for the 3 images that needed it", visionCalls === 3, visionCalls);
  check("kept: the titleless image the picture check approved + the real Galaxy console (not the one it rejected)", r.photos.length === 2 && !r.photos.some((p) => /Guardians|Controller/i.test(p.label)), r.photos.map((p) => p.label));

  section("a failing picture check never files a titleless image (insufficient is not a match)");
  downloads.length = 0; visionCalls = 0;
  visionAnswers.push("error", "error", "error");
  const err = await findReferencePhotos(PRODUCT, { want: 5, candidates: [cands[1], cands[2]] });
  check("nothing is filed when the check errors", err.photos.length === 0, err.photos.length);

  section("Save-credits mode (no picture check): only a title that confirms the product files an image");
  registerLowAiModeSource(() => true);
  downloads.length = 0; visionCalls = 0;
  const free = await findFreeReferencePhotos(PRODUCT, { want: 5, candidates: cands });
  check("no AI call at all", visionCalls === 0);
  check("the game, the controller and the titleless images are not filed", free.length === 1 && /Special Edition Console/.test(free[0].label), free.map((p) => p.label));
  check("the game and the titleless images were not even downloaded", downloads.length === 1 && downloads[0] === "https://img.test/3.jpg", downloads);

  section("the plain product still gets its real photos");
  registerLowAiModeSource(() => false);
  visionAnswers.length = 0;
  visionAnswers.push({ matches: true });
  const plain = await findReferencePhotos("Apple iPhone 15 128GB", { want: 3, candidates: [{ url: "https://img.test/5.jpg", label: "eBay listing: Apple iPhone 15 128GB Blue Unlocked", text: "Apple iPhone 15 128GB Blue Unlocked" }] });
  check("an exact title plus a yes from the picture check is filed", plain.photos.length === 1, plain.photos.length);
});
