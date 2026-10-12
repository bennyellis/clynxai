// Phase 2, item 2: what a Feed card says about the money comes ONLY from the numbers the gate saved with its verdict; nothing is invented, and
// a weakly supported estimate says so. Also: the saved numbers match the gate's own arithmetic and survive the database round trip.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeDealNumbers } from "../../renderer/src/lib/dealNumbers.js";
import { qualifyListing, toGateSnapshot, userEvidence } from "../dealGate.js";
import { assessListingAge } from "../listingAge.js";
import { resaleOutcome } from "../resaleMath.js";
import { Store } from "../store.js";
import type { GateFactsSnapshot } from "../types.js";
import { check, run, section } from "./_testkit.js";
import { scoredListing } from "./_fixtures.js";

const settings = { netPercent: 84, minMarginPercent: 20, maxCutPercent: 15 };
const fresh = assessListingAge("2 hours ago", 48);
const facts = (over: Partial<GateFactsSnapshot> = {}): GateFactsSnapshot => ({
  valueUsd: 480, lotValueUsd: 480, netProceedsUsd: 403, netPercent: 84, profitAtAskUsd: 103, marginAtAskPercent: 25.6, profitAtTargetUsd: null,
  extrasCountedUsd: 0, evidenceLevel: "strong", basis: "sold", sampleSize: 7, ...over,
});
const rec = (over: Record<string, unknown> = {}) => ({ dealStatus: "profitable_now" as const, gateFacts: facts(), gateReasons: [], gateHeadline: "headline", targetPriceUsd: null, ...over });

run(async () => {
  section("what is shown for a normal, well-supported deal");
  {
    const d = describeDealNumbers(rec())!;
    check("resale value, what you keep, profit and margin", d.hasFigures && d.resale === "~$480" && d.keep === "~$403" && d.profit === "+$103" && d.margin === "26%" && d.profitTone === "good", d);
    check("support says how many recent sales it rests on", d.support === "Based on 7 recent eBay sales." && d.supportTone === "ok", d.support);
    check("a deal that was never gated shows nothing new (null: card unchanged)", describeDealNumbers(rec({ dealStatus: null })) === null);
  }

  section("weak or unknown support is labelled, never dressed up");
  {
    check("moderate evidence: plain count", describeDealNumbers(rec({ gateFacts: facts({ evidenceLevel: "moderate", sampleSize: 4 }) }))!.support === "Based on 4 eBay sales.");
    const two = describeDealNumbers(rec({ gateFacts: facts({ evidenceLevel: "weak", sampleSize: 2 }) }))!;
    check("two sales: 'rough estimate' in warning colour", two.support === "Rough estimate: only 2 sales to go on." && two.supportTone === "warn", two);
    check("one sale is singular", describeDealNumbers(rec({ gateFacts: facts({ evidenceLevel: "weak", sampleSize: 1 }) }))!.support === "Rough estimate: only 1 sale to go on.");
    const noSales = describeDealNumbers(rec({ gateFacts: facts({ evidenceLevel: "weak", sampleSize: 0 }) }))!;
    check("zero sales: no confirmed sales", noSales.support === "Rough estimate: no confirmed sales." && noSales.supportTone === "warn");
    const active = describeDealNumbers(rec({ gateFacts: facts({ evidenceLevel: "weak", basis: "active", sampleSize: null }) }))!;
    check("asking prices only is called out", /asking prices only/.test(active.support) && active.supportTone === "warn", active);
    const user = describeDealNumbers(rec({ gateFacts: facts({ evidenceLevel: "moderate", basis: "user", sampleSize: null }) }))!;
    check("a reference price the user typed is attributed to them", user.support === "From the reference price you set.", user);
    const none = describeDealNumbers(rec({ dealStatus: "worth_a_look", gateFacts: facts({ valueUsd: null, lotValueUsd: null, netProceedsUsd: null, profitAtAskUsd: null, marginAtAskPercent: null, evidenceLevel: "none", basis: null, sampleSize: null }) }))!;
    check("no estimate: no figures at all, and it says Clynx doesn't guess", !none.hasFigures && none.resale === null && none.profit === null && none.keep === null && /doesn't guess/.test(none.support), none);
    const partial = describeDealNumbers(rec({ gateFacts: facts({ profitAtAskUsd: null, marginAtAskPercent: null, netProceedsUsd: null }) }))!;
    check("a missing profit is left out, never shown as $0", partial.hasFigures && partial.profit === null && partial.margin === null && partial.keep === null && partial.resale === "~$480", partial);
    const legacy = describeDealNumbers(rec({ gateFacts: null }))!;
    check("gated before the numbers were saved: says so, shows no figures", !legacy.hasFigures && /weren't saved/.test(legacy.support), legacy);
    const extras = describeDealNumbers(rec({ gateFacts: facts({ extrasCountedUsd: 60 }) }))!;
    check("verified extras are mentioned", /Includes ~\$60 of extras/.test(extras.support), extras.support);
  }

  section("a loss and a negotiation");
  {
    const loss = describeDealNumbers(rec({ dealStatus: "pass", gateFacts: facts({ profitAtAskUsd: -20, marginAtAskPercent: -5 }) }))!;
    check("a loss is negative and red", loss.profit === "-$20" && loss.profitTone === "bad" && loss.margin === "-5%", loss);
    const neg = describeDealNumbers(rec({ dealStatus: "negotiation", targetPriceUsd: 400, gateFacts: facts({ profitAtAskUsd: 40, profitAtTargetUsd: 130 }) }))!;
    check("a negotiation shows the profit at the offer price", neg.atTarget === "At a $400 offer: about +$130 profit", neg);
    check("no 'at offer' line for a plain deal", describeDealNumbers(rec())!.atTarget === null);
  }

  section("the explanation: concise, most important first, no repeats");
  {
    const reasons = [
      { code: "MARGIN_OK", severity: "good", text: "About $103 profit after eBay's cut (26% margin at the asking price)." },
      { code: "WEAK_EVIDENCE", severity: "warn", text: "Only 2 sales to go on." },
      { code: "AGE_UNKNOWN", severity: "warn", text: "The listing's age couldn't be read." },
      { code: "HARD_CAP", severity: "bad", text: "Priced above the hard price cap you set." },
      { code: "HIDDEN_GEM", severity: "good", text: "The lot is worth about $540 with the extras." },
    ] as const;
    const d = describeDealNumbers(rec({ gateReasons: reasons, gateHeadline: "Only 2 sales to go on." }))!;
    check("at most two reasons, worst first, the one that repeats the headline and the figures-restating one left out", d.reasons.length === 2 && d.reasons[0].startsWith("Priced above") && d.reasons[1].startsWith("The listing's age"), d.reasons);
    check("the tooltip carries all of them", d.allReasons.length === 5);
  }

  section("the numbers shown are the gate's own (consistency with the real gate)");
  {
    const verdict = qualifyListing({ pathway: "search", priceUsd: 300, conditionImpact: "none", evidence: { valueUsd: 600, basis: "sold", sampleSize: 8, ageDays: 2 }, age: fresh, settings });
    const snap = toGateSnapshot(verdict);
    const expected = resaleOutcome(600, 300, 84);
    check("the saved facts equal resaleOutcome on the same inputs", snap.facts?.lotValueUsd === 600 && snap.facts?.netProceedsUsd === Math.round(expected.keepUsd) && snap.facts?.profitAtAskUsd === Math.round(expected.profitUsd) && snap.facts?.netPercent === 84, snap.facts);
    const d = describeDealNumbers({ dealStatus: snap.status, gateFacts: snap.facts ?? null, gateReasons: snap.reasons, gateHeadline: snap.headline, targetPriceUsd: snap.targetPriceUsd })!;
    check("the card figures are that verdict's figures ($600 sells, keep $504, profit +$204)", d.resale === "~$600" && d.keep === "~$504" && d.profit === "+$204", d);

    const cond = qualifyListing({ pathway: "search", priceUsd: 200, conditionImpact: "minor", evidence: { valueUsd: 600, basis: "sold", sampleSize: 8, ageDays: 2 }, age: fresh, settings });
    check("condition is applied by the gate (minor flaw = 60% of value) and the card shows the adjusted value, not the raw one", cond.facts.lotValueUsd === 360 && toGateSnapshot(cond).facts?.lotValueUsd === 360 && toGateSnapshot(cond).facts?.valueUsd === 600);

    const neg = qualifyListing({ pathway: "search", priceUsd: 450, conditionImpact: "none", evidence: { valueUsd: 600, basis: "sold", sampleSize: 8, ageDays: 2 }, age: fresh, settings });
    const negSnap = toGateSnapshot(neg);
    const dn = describeDealNumbers({ dealStatus: negSnap.status, gateFacts: negSnap.facts ?? null, gateReasons: negSnap.reasons, gateHeadline: negSnap.headline, targetPriceUsd: negSnap.targetPriceUsd })!;
    check("a real negotiation verdict yields the offer line", /^At a \$400 offer: about \+\$\d+ profit$/.test(dn.atTarget ?? ""), dn.atTarget);

    const unknown = qualifyListing({ pathway: "general", priceUsd: 300, conditionImpact: "none", evidence: null, aiFlagged: true, age: fresh, settings });
    const us = toGateSnapshot(unknown);
    const du = describeDealNumbers({ dealStatus: us.status, gateFacts: us.facts ?? null, gateReasons: us.reasons, gateHeadline: us.headline, targetPriceUsd: us.targetPriceUsd })!;
    check("an AI-only find with no evidence shows no invented value or profit", !du.hasFigures && du.resale === null && du.profit === null && us.facts?.lotValueUsd === null, du);

    const thin = qualifyListing({ pathway: "search", priceUsd: 700, conditionImpact: "none", evidence: { valueUsd: 800, basis: "sold", sampleSize: 1, ageDays: 3 }, age: fresh, settings });
    const ts = toGateSnapshot(thin);
    const dt = describeDealNumbers({ dealStatus: ts.status, gateFacts: ts.facts ?? null, gateReasons: ts.reasons, gateHeadline: ts.headline, targetPriceUsd: ts.targetPriceUsd })!;
    check("one sale behind a 'worth a look': the estimate is shown but labelled rough", dt.hasFigures && /Rough estimate/.test(dt.support) && dt.supportTone === "warn", dt);

    const typed = qualifyListing({ pathway: "search", priceUsd: 300, conditionImpact: "none", evidence: userEvidence(600), age: fresh, settings });
    check("the user's own reference price is attributed to them", toGateSnapshot(typed).facts?.basis === "user");
  }

  section("the numbers survive the database, and old databases still open");
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-facts-"));
    const dbPath = path.join(dir, "scout.db");
    const store = new Store(dbPath);
    const verdict = qualifyListing({ pathway: "search", priceUsd: 300, conditionImpact: "none", evidence: { valueUsd: 600, basis: "sold", sampleSize: 8, ageDays: 2 }, age: fresh, settings });
    store.saveScored(scoredListing("Xbox Series X", 300, { gate: toGateSnapshot(verdict), isDeal: true }, { id: "f1" }));
    const back = store.getById("f1");
    check("saved and read back with every figure", back?.gateFacts?.lotValueUsd === 600 && back.gateFacts.profitAtAskUsd === 204 && back.gateFacts.sampleSize === 8 && back.gateFacts.basis === "sold" && back.gateFacts.evidenceLevel === "strong", back?.gateFacts);
    check("also through the list the Feed reads", store.listRecent(10, 0).find((r) => r.id === "f1")?.gateFacts?.netProceedsUsd === 504);
    store.saveScored(scoredListing("Old style", 100, { gate: { ...toGateSnapshot(verdict), facts: undefined } }, { id: "f2" }));
    check("a verdict saved without numbers reads back with gateFacts null (shown as 'weren't saved')", store.getById("f2")?.gateFacts === null);
    store.saveScored(scoredListing("Never gated", 100, {}, { id: "f3" }));
    check("a listing that was never gated has no numbers", store.getById("f3")?.gateFacts === null && store.getById("f3")?.dealStatus === null);
    store.close();

    // a database from before the column existed
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec("ALTER TABLE listings DROP COLUMN gate_facts");
    raw.close();
    const reopened = new Store(dbPath);
    check("an older database gains the column on open and keeps its rows", reopened.getById("f1")?.gateFacts === null && !!reopened.getById("f1"));
    reopened.saveScored(scoredListing("Xbox Series X", 300, { gate: toGateSnapshot(verdict), isDeal: true }, { id: "f1" }));
    check("and can save the numbers again", reopened.getById("f1")?.gateFacts?.lotValueUsd === 600);
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
