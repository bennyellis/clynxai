// Command-line harness for the sold-comps module. Bundled and run by scripts/sold-comps-harness.cjs:
//   node scripts/sold-comps-harness.cjs --product "Xbox Series X Galaxy Black Special Edition" --csv path/to/sales.csv [--gtin 0889842...] [--query "words"]
// Loads a CSV / paste (the manual-import format) into an IN-MEMORY database, judges every sale for the product, and prints each verdict, the price summary, why there was nothing (if there
// was nothing) and, when the CSV has a `label` column (accept / reject), the accuracy against it. It never touches the network, the real Database or any Clynx setting.
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { accuracyReport, formatAccuracy, type Label } from "./accuracy.js";
import { ManualImportProvider, parseSoldImport } from "./manualImport.js";
import { matchAll } from "./match.js";
import { SoldCompsService } from "./service.js";
import { SoldCompsStore } from "./store.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const product = arg("product");
  const csv = arg("csv");
  if (!product || !csv) {
    console.error('usage: --product "<official product name>" --csv <file> [--gtin <digits>] [--epid <id>] [--query "<search words>"]');
    process.exit(2);
  }
  const text = fs.readFileSync(csv, "utf8");
  const imported = parseSoldImport(text);
  console.log(`read ${imported.comps.length} sales from ${csv}${imported.skipped.length ? `, skipped ${imported.skipped.length}:` : ""}`);
  for (const s of imported.skipped) console.log(`  line ${s.line}: ${s.reason}  ${s.text}`);

  const db = new DatabaseSync(":memory:");
  const store = new SoldCompsStore(db);
  store.upsertComps(imported.comps);
  const identity = { id: "harness", name: product, query: arg("query") ?? null, gtin: arg("gtin") ?? null, epid: arg("epid") ?? null };
  const service = new SoldCompsService({ store, providers: [new ManualImportProvider(() => store.listComps("manual_import"))], log: (l) => console.log(l), enoughUsable: 1_000_000 });
  const result = await service.research(identity);

  console.log("\nverdicts:");
  for (const m of result.matches) {
    const comp = store.getComps([m.compId])[0];
    console.log(`  ${m.accepted ? "USE " : "SKIP"} ${String(m.verdict).padEnd(10)} $${String(comp.soldPrice).padEnd(8)} ${comp.title}${m.reason ? `   [${m.reason}]` : ""}`);
  }
  if (result.summary) {
    const s = result.summary;
    console.log(`\nsummary: ${s.count} usable, median $${s.medianUsd}, range $${s.lowUsd}-$${s.highUsd}, trimmed mean ${s.trimmedMeanUsd === null ? "n/a" : "$" + s.trimmedMeanUsd}, confidence ${s.confidence}. ${s.note}`);
  }
  if (result.zero) console.log(`\nNO USABLE SALES (${result.zero.kind}): ${result.zero.text}`);

  const labelled = imported.comps.flatMap((c) => {
    const label = String((c.raw as Record<string, unknown> | null)?.label ?? "").toLowerCase();
    return label === "accept" || label === "reject" ? [{ comp: c, label: label as Label }] : [];
  });
  if (labelled.length > 0) {
    const matches = await matchAll(identity, labelled.map((l) => l.comp));
    console.log("\naccuracy vs hand labels:\n" + formatAccuracy(accuracyReport(labelled.map((l, i) => ({ title: l.comp.title, label: l.label, match: matches[i] })))));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
