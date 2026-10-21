// Attention dots: which review items are unopened, how a folder's dot derives from what is below it, the cap on pulsing dots, and that opening an item (and only that) clears its dot.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../store.js";
import { attentionBelow, attentionLabel, attentionProductIds, MAX_PULSING_DOTS, shouldPulse, type AttentionSummary } from "../../renderer/src/lib/attention.js";
import { check, run, section } from "./_testkit.js";

run(async () => {
  section("the store: unopened review items");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-attn-"));
  const store = new Store(path.join(dir, "scout.db"));
  const a = store.addProductStub("a", "Zorblax 3000");
  const b = store.addProductStub("b", "Quuxatron 9");
  const img = store.addReviewItem({ kind: "image", subjectId: "img1", reasons: ["title disagrees"], evidence: { productId: a } });
  const merge = store.addReviewItem({ kind: "merge", subjectId: "k", reasons: ["same words"], evidence: { ids: [a, b] } });
  const first = store.attentionSummary();
  check("both open items are waiting, each knowing which entries it touches", first.count === 2 && first.items.find((i) => i.id === img)?.productIds.join() === a && first.items.find((i) => i.id === merge)?.productIds.join() === `${a},${b}`, first);
  store.ackAttention(img);
  check("opening ONE item clears only that one", store.attentionSummary().count === 1 && store.attentionSummary().items[0].id === merge);
  store.ackAttention(img);
  check("opening it twice changes nothing", store.attentionSummary().count === 1);
  store.resolveReviewItem(merge, "rejected", "user");
  check("an item resolved without being opened leaves the list too", store.attentionSummary().count === 0);
  const later = store.addReviewItem({ kind: "image", subjectId: "img2", reasons: ["x"], evidence: { productId: b } });
  check("a new item that needs attention lights up again", store.attentionSummary().count === 1 && store.attentionSummary().items[0].id === later);
  check("'mark all as seen' clears everything waiting and reports how many", store.ackAllAttention() === 1 && store.attentionSummary().count === 0);

  section("derived dots");
  const s: AttentionSummary = { count: 3, items: [{ id: "1", kind: "image", productIds: ["p1"] }, { id: "2", kind: "merge", productIds: ["p1", "p2"] }, { id: "3", kind: "image", productIds: ["p9"] }] };
  check("a folder's dot counts the unopened items below it, and stays while any remain", attentionBelow(s, ["p1", "p2"]) === 2 && attentionBelow(s, ["p2"]) === 1 && attentionBelow(s, ["p7"]) === 0);
  check("an entry's own dot", attentionProductIds(s).join() === "p1,p2,p9");
  check("the accessible label counts", attentionLabel(1) === "1 thing needs your attention" && attentionLabel(3) === "3 things need your attention");
  const many: AttentionSummary = { count: 9, items: Array.from({ length: 9 }, (_, i) => ({ id: `i${i}`, kind: "image", productIds: [`p${i}`] })) };
  const pulsing = Array.from({ length: 9 }, (_, i) => shouldPulse(many, [`p${i}`])).filter(Boolean).length;
  check(`no more than ${MAX_PULSING_DOTS} dots pulse at once, the rest are steady`, pulsing === MAX_PULSING_DOTS && shouldPulse(many, ["p0", "p8"]) === true && shouldPulse(many, ["p8"]) === false);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp cleanup can fail on Windows */
  }
});
