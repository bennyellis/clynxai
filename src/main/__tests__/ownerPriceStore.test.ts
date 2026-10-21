// Phase 4a on a throwaway Database: the owner's number feeds the deal evidence at its low end only while it is valid, real sold prices lead, and the questions are queued within the allowance.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../store.js";
import { evidenceFromSignals } from "../dealGate.js";
import { check, run, section } from "./_testkit.js";

const DAY = 86_400_000;
run(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-ownerprice-"));
  const store = new Store(path.join(dir, "scout.db"));
  const db = (store as any).db;
  const T0 = Date.now();
  const id = store.addProductStub("p1", "Zorblax 3000");
  db.prepare("UPDATE products SET loading = 0, prioritized = 1 WHERE id = 'p1'").run();

  section("the owner's number as the value when nothing else is known");
  check("without any number there is no value", store.getProductSignals("Zorblax 3000", "Zorblax 3000 for sale")?.valueUsd === null);
  const bad = store.setOwnerPrice(id, { lowUsd: -5 });
  check("a bad number is refused in plain words", bad.ok === false && /dollars/.test((bad as { error: string }).error));
  check("saved: the low end of the range is the value, and it is the owner's word, not sold prices", (() => {
    store.setOwnerPrice(id, { lowUsd: 180, highUsd: 220, condition: "used - good", includes: "controller" }, T0);
    const sig = store.getProductSignals("Zorblax 3000", "Zorblax 3000 for sale");
    const ev = evidenceFromSignals(sig);
    return sig?.valueUsd === 180 && sig?.basis === "owner" && ev?.basis === "user";
  })());
  check("real sold prices take over: the stored comps lead", (() => {
    store.updateProductEbayComps(id, { avgSoldPriceUsd: 240, avgRunTimeDays: 3, avgShippingUsd: 0, sampleSize: 8, activeMedianUsd: 250, activeSampleSize: 6, estimatedValueUsd: 240, estimateBasis: "sold", identity: "exact" });
    const sig = store.getProductSignals("Zorblax 3000", "Zorblax 3000 for sale");
    return sig?.valueUsd === 240 && sig?.basis === "sold";
  })());
  check("marking it replaced keeps the number visible but unused", (() => {
    store.markOwnerPriceReplaced(id);
    return store.getOwnerPrice(id)?.lowUsd === 180 && store.getOwnerPrice(id)?.replacedAt !== null && store.ownerValueFor(id) === null;
  })());
  check("a new answer from the owner makes it live again", store.setOwnerPrice(id, { lowUsd: 190 }).ok && store.ownerValueFor(id) === 190);

  section("the questions");
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) {
    const pid = store.addProductStub(`q${i}`, `Quuxatron ${i}00 Model`);
    db.prepare("UPDATE products SET loading = 0, prioritized = 1 WHERE id = ?").run(pid);
    ids.push(pid);
  }
  const added = store.queuePriceQuestions(T0);
  const open = store.listReviewItems("open").filter((i) => i.kind === "price");
  check("only a few are asked per day, as Review items", added === 3 && open.length === 3, { added, open: open.length });
  check("they light the attention dot, each knowing its entry", store.attentionSummary().items.filter((i) => i.kind === "price").length === 3 && open.every((i) => store.attentionSummary().items.find((a) => a.id === i.id)?.productIds[0] === i.subjectId));
  check("asking again the same day adds nothing", store.queuePriceQuestions(T0 + 1000) === 0);
  const next = store.queuePriceQuestions(T0 + DAY + 1000);
  check("the next day asks about others, never the ones just asked", next === 3 && store.listReviewItems("open").filter((i) => i.kind === "price").length === 6);
  store.recordPricePrompt(ids[0], "never", T0 + 2 * DAY);
  check("an entry set to 'don't ask' stays out for good", store.queuePriceQuestions(T0 + 200 * DAY) <= 5 && !store.listPricePrompts().some((p) => p.productId === ids[0] && p.state === "asked" && p.at > T0 + 2 * DAY));
  check("the entry that already has sold prices and an answer was never asked about", !store.listReviewItems("all").some((i) => i.kind === "price" && i.subjectId === id));
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp cleanup can fail on Windows */
  }
});
