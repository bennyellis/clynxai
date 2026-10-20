// Accuracy of the matcher against a HAND-LABELLED set: the labels say whether a person would let that sale price the product. Precision is what matters most (a wrong comp prices a product
// wrongly); recall says how many good sales are being thrown away. Pure.
import type { CompMatch } from "./match.js";

export type Label = "accept" | "reject";

export interface AccuracyReport {
  total: number;
  accepted: number;
  truePositives: number;
  falsePositives: Array<{ title: string; reason: string }>;
  missed: Array<{ title: string; verdict: string; reason: string }>;
  trueNegatives: number;
  /** Of the comps the matcher accepted, the share a person would also accept (1 when it accepted none). */
  precision: number;
  /** Of the comps a person would accept, the share the matcher accepted. */
  recall: number;
}

export function accuracyReport(rows: Array<{ title: string; label: Label; match: CompMatch }>): AccuracyReport {
  const falsePositives: AccuracyReport["falsePositives"] = [];
  const missed: AccuracyReport["missed"] = [];
  let tp = 0;
  let tn = 0;
  for (const r of rows) {
    if (r.match.accepted && r.label === "accept") tp++;
    else if (r.match.accepted && r.label === "reject") falsePositives.push({ title: r.title, reason: r.match.reason });
    else if (!r.match.accepted && r.label === "accept") missed.push({ title: r.title, verdict: r.match.verdict, reason: r.match.reason });
    else tn++;
  }
  const accepted = tp + falsePositives.length;
  const wanted = tp + missed.length;
  return { total: rows.length, accepted, truePositives: tp, falsePositives, missed, trueNegatives: tn, precision: accepted === 0 ? 1 : tp / accepted, recall: wanted === 0 ? 1 : tp / wanted };
}

export function formatAccuracy(a: AccuracyReport): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const lines = [`${a.total} labelled sales: matcher accepted ${a.accepted}; precision ${pct(a.precision)} (${a.truePositives} of ${a.accepted} accepted are right), recall ${pct(a.recall)} (${a.truePositives} of ${a.truePositives + a.missed.length} good sales kept).`];
  for (const f of a.falsePositives) lines.push(`  WRONGLY ACCEPTED: ${f.title}  [${f.reason}]`);
  for (const m of a.missed) lines.push(`  GOOD SALE LOST:   ${m.title}  [${m.verdict}: ${m.reason}]`);
  return lines.join("\n");
}
