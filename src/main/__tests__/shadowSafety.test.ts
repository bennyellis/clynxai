// Phase 4 stage 0b: the shadow tools must be unable to change anything. Static checks on their source (they are never imported by the app).
import fs from "node:fs";
import path from "node:path";
import { check, run, section } from "./_testkit.js";

const raw = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

run(() => {
  section("the analysis modules are pure");
  for (const f of ["resolver.ts", "shadow.ts", "words.ts", "codes.ts", "populations.ts", "credibility.ts", "foundationResolver.ts", "safeguard.ts", "reviewFindings.ts"]) {
    const src = strip(raw(`src/main/identity/${f}`));
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    check(`${f} imports only other identity modules`, imports.every((i) => i.startsWith("./") && !/notify|openai|scrapeEngine|index|browser|vision|store|watchcount|ebay/i.test(i)), imports);
    check(`${f} does no I/O and no network`, !/\b(fetch|readFile|writeFile|appendFile|sqlite|process\.env|child_process|XMLHttpRequest)\b/.test(src));
  }

  section("nothing in the app imports the shadow tools");
  {
    const mainDir = path.join(process.cwd(), "src", "main");
    const offenders = fs.readdirSync(mainDir).filter((f) => f.endsWith(".ts") && /identity\/(shadow|resolver|foundationResolver)/.test(fs.readFileSync(path.join(mainDir, f), "utf8")));
    check("no live module uses the shadow resolvers", offenders.length === 0, offenders);
  }

  section("the command-line runner is read-only and offline");
  {
    const text = raw("audit/phase4_shadow/run.ts");
    const code = strip(text);
    check("the database is opened read-only", /readOnly:\s*true/.test(code));
    check("it refuses the app's live data folder", /Refusing to run/.test(text) && /fb-marketplace-scout/.test(text) && /process\.exit\(2\)/.test(text));
    check("network is blocked and counted", /globalThis\.fetch\s*=/.test(code));
    const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).join(" ");
    check("it does not import the app's notification, AI, scraper or database-writing code", !/notify|openai|scrapeEngine|electron|playwright|\/index/i.test(imports), imports);
    check("it contains no SQL that writes", !/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|CREATE\s+TABLE|VACUUM)\b/i.test(code));
    check("the database copy is hashed before and after", (code.match(/sha256/g) ?? []).length >= 2);
  }

  section("the veto-only safeguard and the review screen are OFF by default and cannot be switched on by anything but config.json");
  {
    const cfg = strip(raw("src/main/config.ts"));
    check("the default config has the safeguard off and review decisions off", /identitySafeguard:\s*\{\s*mode:\s*"off"\s*\}/.test(cfg) && /databaseReview:\s*\{\s*decisions:\s*false\s*\}/.test(cfg));
    const idx = strip(raw("src/main/index.ts"));
    const calls = idx.match(/setIdentitySafeguard\(/g) ?? [];
    check("the app sets the safeguard mode in exactly one place, from config.identitySafeguard.mode", calls.length === 1 && /config\.identitySafeguard\?\.mode/.test(idx));
    check("nothing in the renderer or preload can change the mode", !/setIdentitySafeguard|identitySafeguard/.test(raw("src/preload/index.ts") + raw("src/renderer/src/screens/ReviewTab.tsx")));
    const rt = strip(raw("src/main/identity/safeguardRuntime.ts"));
    check("the runtime does no I/O of its own (the log writer is handed in)", !/(fetch|readFile|writeFile|appendFile|sqlite|process\.env|child_process)/.test(rt) && !/node:fs/.test(rt));
    check("the decision module never picks or returns another product to file under (it returns allow / veto / unsure only)", /Decision = "allow" \| "veto" \| "unsure"/.test(strip(raw("src/main/identity/safeguard.ts"))));
    const store = strip(raw("src/main/store.ts"));
    check("every Store path that vetoes a match only ever sets the match to none or returns no value", (store.match(/safeguard\.vetoes\(/g) ?? []).length >= 6 && !/safeguard\.decide\(/.test(store));
  }

  section("the stage 3b / 6a tools work on scratch copies only, offline, and prove the source did not change");
  for (const f of ["stage3b_run.ts", "stage6a_audit.ts", "stage6a_roundtrip.ts"]) {
    const text = raw(`audit/phase4_shadow/${f}`);
    const code = strip(text);
    check(`${f} refuses the app's live data folder`, /Refusing to run/.test(text) && /fb-marketplace-scout/.test(text) && /process\.exit\(2\)/.test(text));
    check(`${f} copies the database to a scratch folder and removes it afterwards`, /copyFileSync/.test(code) && /rmSync\(scratch/.test(code));
    check(`${f} hashes the source before and after`, (code.match(/sha256|sha\(source\)/g) ?? []).length >= 2);
    const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).join(" ");
    check(`${f} does not import notification, AI, scraper or browser code`, !/notify|openai|scrapeEngine|electron|playwright|vision|watchcount|\/index/i.test(imports), imports);
  }
  check("stage 3b and 6a audit block the network", ["stage3b_run.ts", "stage6a_audit.ts"].every((f) => /globalThis\.fetch\s*=/.test(strip(raw(`audit/phase4_shadow/${f}`)))));
  check("the audit itself contains no SQL that writes (the round-trip test is the only writer, on its own scratch copy)", !/(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE)/i.test(strip(raw("audit/phase4_shadow/stage6a_audit.ts"))));
  {
    const journal = strip(raw("audit/phase4_shadow/correction_journal.ts"));
    check("the correction journal only allows one-row updates of named columns (no insert into data tables, no delete)", !/DELETE\s+FROM/i.test(journal) && !/INSERT\s+INTO\s+(?!correction_journal)/i.test(journal));
    const mainDir = path.join(process.cwd(), "src");
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".ts") || e.name.endsWith(".tsx") ? [path.join(d, e.name)] : []));
    const offenders = walk(mainDir).filter((f) => !f.includes("__tests__") && /from\s+"[^"]*(correction_journal|phase4_shadow)[^"]*"/.test(fs.readFileSync(f, "utf8")));
    check("nothing in the app imports the audit tools or the correction journal", offenders.length === 0, offenders);
  }
});
