// Discovery UI step 2 (AUDITOR proposal section 1, owner-accepted): the Live feed column as a vertical stack of the Dashboard's live-tile look. The words each tile shows come from a pure model
// (lib/liveFeed.ts); the rest is checked as the shape of the screen's source (no screen here). Nothing about how entries are created, ordered by the main process or stored changes.
import fs from "node:fs";
import path from "node:path";
import { agoText, latestThought, liveTileModel, orderTiles } from "../../renderer/src/lib/liveFeed.js";
import { check, run, section } from "./_testkit.js";

const NOW = 2_000_000_000_000;
const entry = (over: Partial<Parameters<typeof liveTileModel>[0]> = {}) => ({ status: "done" as const, startedAt: NOW - 5 * 60_000, finishedAt: NOW - 3 * 60_000, thoughts: [] as Array<{ ts: number; kind: "start" | "step" | "finding" | "warn" | "reaction"; text: string }>, ...over });

run(async () => {
  section("a researching product is the full live tile");
  const r = liveTileModel(entry({ status: "researching", finishedAt: null, thoughts: [{ ts: 1, kind: "start", text: "Looking into Xbox Series X" }, { ts: 2, kind: "step", text: "Reading the Microsoft page for the Galaxy edition" }] }), null, null, NOW);
  check("chip says Researching, tone is live, and it is not compact", r.chip === "Researching" && r.tone === "live" && r.researching && !r.compact, r);
  check("its status line is the latest thing Clynx said (not the opener)", r.line === "Reading the Microsoft page for the Galaxy edition", r.line);
  check("with only the opener said, the opener is used; with nothing said, 'Looking into it'", liveTileModel(entry({ status: "researching", finishedAt: null, thoughts: [{ ts: 1, kind: "start", text: "Looking into Xbox Series X" }] }), null, null, NOW).line === "Looking into Xbox Series X" && liveTileModel(entry({ status: "researching", finishedAt: null }), null, null, NOW).line === "Looking into it");
  check("a long thought is cut to one readable line", latestThought({ thoughts: [{ ts: 1, kind: "step", text: "word ".repeat(80) }] })!.length <= 110 && latestThought({ thoughts: [{ ts: 1, kind: "step", text: "word ".repeat(80) }] })!.endsWith("…"));

  section("a finished product folds to one compact line with a verdict chip");
  const chips = (["strong", "decent", "thin", "pass", "unknown"] as const).map((l) => liveTileModel(entry(), l, 1100, NOW).chip);
  check("Worth flipping / Decent / Marginal / Not great / Can't judge", chips.join() === "Worth flipping,Decent,Marginal,Not great,Can't judge", chips);
  check("tones: good, info, warn, bad, dim", (["strong", "decent", "thin", "pass", "unknown"] as const).map((l) => liveTileModel(entry(), l, 1100, NOW).tone).join() === "good,info,warn,bad,dim");
  const done = liveTileModel(entry(), "strong", 1087.4, NOW);
  check("value and how long ago, compact, not researching", done.line === "Worth about $1087 · 3 min ago" && done.compact && !done.researching, done);
  check("no value -> just how long ago; no verdict at all -> Can't judge", liveTileModel(entry(), null, null, NOW).line === "3 min ago" && liveTileModel(entry(), null, null, NOW).chip === "Can't judge" && liveTileModel(entry(), "strong", 0, NOW).line === "3 min ago");
  const failed = liveTileModel(entry({ status: "failed" }), null, null, NOW);
  check("a failed one says Didn't work out, in a warning tone, compact", failed.chip === "Didn't work out" && failed.tone === "warn" && failed.compact && failed.line === "3 min ago", failed);
  check("times read naturally", agoText(NOW - 10_000, NOW) === "just now" && agoText(NOW - 5 * 60_000, NOW) === "5 min ago" && agoText(NOW - 3 * 3600_000, NOW) === "3 hr ago" && agoText(NOW - 2 * 86400_000, NOW) === "2 days ago" && agoText(NOW - 86400_000, NOW) === "1 day ago");

  section("order: researching first (newest first), the rest untouched");
  const list = [{ id: "a", status: "done", startedAt: 5 }, { id: "b", status: "researching", startedAt: 1 }, { id: "c", status: "failed", startedAt: 9 }, { id: "d", status: "researching", startedAt: 7 }];
  check("researching d, b then a, c in their original order", orderTiles(list).map((e) => e.id).join() === "d,b,a,c");
  check("the input list is not changed", list.map((e) => e.id).join() === "a,b,c,d");

  section("the screen: tiles in place of the old rows, same data, same click, same header");
  const disc = fs.readFileSync(path.join(process.cwd(), "src", "renderer", "src", "screens", "DiscoveryTab.tsx"), "utf8");
  const tile = fs.readFileSync(path.join(process.cwd(), "src", "renderer", "src", "components", "LiveFeedTile.tsx"), "utf8");
  check("the Live feed column renders LiveFeedTile for every entry and still opens it on click", /orderTiles\(entries\)\.map\(\(entry\) => \(\s*<LiveFeedTile/.test(disc) && /onClick=\{\(\) => selectEntry\(entry\)\}/.test(disc));
  check("'Ask Clynx' stays on top as before, and the header still says Live feed with the researching count", /title="Ask Clynx"/.test(disc) && /<strong>Live feed<\/strong>/.test(disc) && /\{researchingCount\} researching/.test(disc));
  const feedColumn = disc.slice(disc.indexOf("<strong>Live feed</strong>"), disc.indexOf("---- right: two channels"));
  check("the mixed emoji thumbnails are gone from the feed column (the photo, else the Clynx logo)", feedColumn.length > 200 && !/⚙️|📦/.test(feedColumn) && /clynx-mark\.png/.test(tile));
  check("the researching tile reuses the Dashboard's pulsing dot and shows the product photo", /liveDotPulse/.test(tile) && /<Thumb url=\{photoUrl\} size=\{56\}/.test(tile));
  check("finished entries are the compact one-line tile", /data-testid="live-tile-compact"/.test(tile) && /<Thumb url=\{photoUrl\} size=\{30\}/.test(tile));
  check("no new animation beyond the existing dot (nothing but transform / opacity would be added)", !/transition:|@keyframes|animation:/.test(tile.replace(/animation: "liveDotPulse[^"]*"/, "")));
});
