// Phase 4 stage 0b: the shadow tools must be unable to change anything. Static checks on their source (they are never imported by the app).
import fs from "node:fs";
import path from "node:path";
import { check, run, section } from "./_testkit.js";

const raw = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

run(() => {
  section("the analysis modules are pure");
  for (const f of ["resolver.ts", "shadow.ts", "words.ts", "codes.ts", "populations.ts"]) {
    const src = strip(raw(`src/main/identity/${f}`));
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    check(`${f} imports only other identity modules`, imports.every((i) => i.startsWith("./") && !/notify|openai|scrapeEngine|index|browser|vision|store|watchcount|ebay/i.test(i)), imports);
    check(`${f} does no I/O and no network`, !/\b(fetch|readFile|writeFile|appendFile|sqlite|process\.env|child_process|XMLHttpRequest)\b/.test(src));
  }

  section("nothing in the app imports the shadow tools");
  {
    const mainDir = path.join(process.cwd(), "src", "main");
    const offenders = fs.readdirSync(mainDir).filter((f) => f.endsWith(".ts") && /identity\/(shadow|resolver)/.test(fs.readFileSync(path.join(mainDir, f), "utf8")));
    check("no live module uses the shadow resolver", offenders.length === 0, offenders);
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
});
