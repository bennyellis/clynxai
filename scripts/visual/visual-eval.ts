// REAL-IMAGE evaluation of Clynx's visual identification. Sends the cached reference/regression images to the actual vision model and scores the answers against the manifest.
// This is the check a mocked test cannot be: it needs working AI access and the images from scripts/reference-fetch.cjs. It uses THE SAME ROUTE AS THE APP: your own key when
// OPENAI_API_KEY is set, otherwise Clynx Cloud's shared AI (what your owner console runs) when you give it a Clynx account: CLYNX_CLOUD_URL, CLYNX_CLOUD_EMAIL, CLYNX_CLOUD_PASSWORD.
// The login makes one extra "device" in that account, like any sign-in, and is never saved to disk.
//   node scripts/visual-eval.cjs                  image cases only (photos -> the model; no web search)
//   node scripts/visual-eval.cjs --web            also let identification search the web (DuckDuckGo/Bing, no key) and run claim checks
// It reports, per case and in total: correct family / model, false exact matches, appropriate uncertainty, claim-check verdicts, calls made and the estimated cost. It never
// writes to any database.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { KnowledgeGraph } from "../../src/main/knowledgeGraph.js";
import { seedNintendoHandhelds } from "../../src/main/knowledgeSeeds.js";
import { identifyFromObservation } from "../../src/main/identityResearch.js";
import { openAiObserver, openAiThemeClassifier } from "../../src/main/visualObserver.js";
import { challengeModelClaim } from "../../src/main/claimChallenge.js";
import { createEvidenceDeps, DEFAULT_BACKENDS } from "../../src/main/webEvidence.js";
import { apiActivity } from "../../src/main/apiActivity.js";
import { CloudClient } from "../../src/main/cloudClient.js";
import { initOpenAIProxy, setApiSource } from "../../src/main/openai.js";
import os from "node:os";
import type { Manifest, ManifestImage } from "../../src/main/referenceManifest.js";

const root = process.cwd();
const dir = path.join(root, "reference-data");
const useWeb = process.argv.includes("--web");

function dataUri(img: ManifestImage): string | null {
  for (const ext of ["jpg", "png", "webp"]) {
    const f = path.join(dir, "cache", `${img.id}.${ext}`);
    if (fs.existsSync(f)) return `data:${ext === "jpg" ? "image/jpeg" : "image/" + ext};base64,${fs.readFileSync(f).toString("base64")}`;
  }
  return null;
}

async function main() {
  const ownKey = process.env.OPENAI_API_KEY && !/^(test-key|audit-no-network)/.test(process.env.OPENAI_API_KEY);
  let route = "";
  if (ownKey) {
    setApiSource(() => "own");
    route = "your own OpenAI key";
  } else {
    const url = process.env.CLYNX_CLOUD_URL, email = process.env.CLYNX_CLOUD_EMAIL, password = process.env.CLYNX_CLOUD_PASSWORD;
    if (!url || !email || !password) {
      console.log("No AI access: set OPENAI_API_KEY, or sign in to Clynx Cloud with CLYNX_CLOUD_URL, CLYNX_CLOUD_EMAIL and CLYNX_CLOUD_PASSWORD (the same shared AI your owner console serves). Nothing was verified by this run.");
      process.exit(2);
    }
    const client = new CloudClient(() => ({ cloud: { apiUrl: url } }) as never, path.join(os.tmpdir(), `clynx-eval-session-${process.pid}.json`));
    const login = await client.login(url, email, password);
    if (!login.ok) {
      console.log(`Could not sign in to Clynx Cloud: ${login.error}. Nothing was verified by this run.`);
      process.exit(2);
    }
    initOpenAIProxy(client);
    setApiSource(() => "shared");
    route = "Clynx Cloud (shared AI)";
  }
  console.log(`AI route: ${route}.`);
  const resolvedPath = path.join(dir, "manifest.resolved.json");
  if (!fs.existsSync(resolvedPath)) {
    console.log("Run scripts/reference-fetch.cjs first (it downloads and verifies the images).");
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(resolvedPath, "utf8")) as Manifest;
  const cases = (JSON.parse(fs.readFileSync(path.join(dir, "cases.json"), "utf8")) as { cases: any[] }).cases;
  const graph = new KnowledgeGraph(new DatabaseSync(":memory:"));
  const seeded = seedNintendoHandhelds(graph);
  const web = useWeb ? createEvidenceDeps({ backends: DEFAULT_BACKENDS(), searchGapMs: 800 }) : { search: async () => [], fetchText: async () => null };
  const observer = openAiObserver();
  const rows: Array<Record<string, unknown>> = [];
  const tally = { cases: 0, skipped: 0, familyRight: 0, familyAsked: 0, modelRight: 0, modelAsked: 0, falseExact: 0, answersRight: 0, answersWrong: 0, answersUncertain: 0, claimRight: 0, claimAsked: 0 };
  for (const c of cases) {
    if (c.needsImages) { tally.skipped++; rows.push({ id: c.id, result: "SKIPPED (needs images that were not supplied)" }); continue; }
    if (c.kind === "claim") {
      if (!useWeb) { tally.skipped++; rows.push({ id: c.id, result: "SKIPPED (needs --web)" }); continue; }
      const r = await challengeModelClaim(c.claim, web);
      tally.claimAsked++;
      const ok = r.verdict === c.expected.verdict;
      if (ok) tally.claimRight++;
      rows.push({ id: c.id, result: ok ? "PASS" : "FAIL", got: r.verdict, expected: c.expected.verdict, note: r.note });
      continue;
    }
    const imgs = (c.imageIds as string[]).map((id) => manifest.images.find((i) => i.id === id)).filter((i): i is ManifestImage => !!i);
    const uris = imgs.map(dataUri).filter((u): u is string => !!u);
    if (!uris.length) { tally.skipped++; rows.push({ id: c.id, result: "SKIPPED (images not downloaded or not valid)" }); continue; }
    tally.cases++;
    if (c.kind === "targeted_answers") {
      const ds = graph.discriminators(seeded.familyId);
      const answers = await observer.answer(uris, ds.map((d) => ({ aspect: d.aspect, question: d.question, options: d.options })));
      const detail: Record<string, string> = {};
      for (const d of ds) {
        const want = imgs[0].expectedAnswers[d.aspect];
        if (!want) continue;
        const got = answers?.[d.aspect]?.option ?? "no answer";
        detail[d.aspect] = `${got} (expected ${want})`;
        if (got === want) tally.answersRight++;
        else if (got === "not_visible" || got === "no answer") tally.answersUncertain++;
        else tally.answersWrong++;
      }
      rows.push({ id: c.id, result: "scored", detail });
      continue;
    }
    if (c.kind === "identity") {
      const d = await identifyFromObservation({ images: uris, title: c.title }, { graph, web, observer, themes: useWeb ? openAiThemeClassifier() : undefined });
      tally.familyAsked++;
      if (d.family?.value === c.expected.family) tally.familyRight++;
      const model = d.model?.value ?? null;
      let verdict = "n/a";
      if (c.expected.modelOneOf) {
        tally.modelAsked++;
        const right = model ? c.expected.modelOneOf.includes(model) : false;
        if (right) tally.modelRight++;
        if (model && (c.expected.mustNotBe ?? []).includes(model)) tally.falseExact++;
        verdict = model ? (right ? "model in the expected set" : "WRONG MODEL") : `undecided (${d.remainingModels.join(", ") || "unknown"})`;
      } else if (c.expected.model === null) {
        verdict = model ? "FALSE EXACT MATCH (several devices in the photo)" : "appropriately undecided";
        if (model) tally.falseExact++;
      }
      rows.push({ id: c.id, result: verdict, family: d.family?.value ?? null, model, remaining: d.remainingModels, edition: d.edition?.value ?? null, uncertainty: d.uncertainty, trace: d.trace });
    }
  }
  const snap = apiActivity.snapshot().providers.openai;
  const report = { when: new Date().toISOString(), aiRoute: route, web: useWeb, tally, rows, openai: { requests: snap.attempted, tokens: snap.tokens, costUsdEstimate: snap.costUsdEst, costComplete: snap.costUsdEstComplete } };
  for (const r of rows) console.log(`${String(r.id).padEnd(28)} ${String(r.result)}${r.detail ? "  " + JSON.stringify(r.detail) : ""}${r.got ? `  got ${r.got}, expected ${r.expected}` : ""}`);
  console.log(`\nCases run ${tally.cases}, skipped ${tally.skipped}. Targeted answers: ${tally.answersRight} right, ${tally.answersWrong} wrong, ${tally.answersUncertain} uncertain. Family ${tally.familyRight}/${tally.familyAsked}, model ${tally.modelRight}/${tally.modelAsked}, false exact matches ${tally.falseExact}. Claim checks ${tally.claimRight}/${tally.claimAsked}.`);
  console.log(`OpenAI: ${snap.attempted} request(s), ${snap.tokens.total} tokens, estimated cost ${snap.costUsdEstComplete ? "~" : "at least ~"}$${snap.costUsdEst.toFixed(3)}.`);
  const file = path.join(dir, `eval-report-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`Report: ${file}`);
  process.exit(0); // the Clynx Cloud sign-in keeps a refresh timer alive
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
