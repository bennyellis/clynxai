// Fetches, licenses and verifies the reference images listed in reference-data/manifest.json. Run on a machine with internet access (it needs no key):
//   node scripts/reference-fetch.cjs                       resolve every image, write reference-data/manifest.resolved.json and the files to reference-data/cache/
//   node scripts/reference-fetch.cjs --discover New_Nintendo_3DS_XL     list Commons files in a category as CANDIDATES (never added as trusted)
// Each image is accepted only with a licence that allows use and an attribution that could be read; its bytes are checked (type, size, decodable, checksum). An unavailable
// or changed source is reported and kept in the resolved manifest as such.
import fs from "node:fs";
import path from "node:path";
import { checkImageBytes, commonsApiUrl, fetchReference, parseCategoryMembers, validateManifest, usableAsReference, type FetchDeps, type Manifest } from "../../src/main/referenceManifest.js";

const root = process.cwd();
const dir = path.join(root, "reference-data");
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const deps: FetchDeps = {
  async get(url) {
    try {
      const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "ClynxReferenceFetch/1.0 (private beta; https://github.com/bennyellis/clynxai)" } });
      const body = Buffer.from(await res.arrayBuffer());
      return { ok: res.ok, status: res.status, contentType: res.headers.get("content-type") ?? undefined, body };
    } catch (err) {
      return { ok: false, status: 0, error: (err as Error).message };
    }
  },
};

async function main() {
  const discover = flag("--discover");
  if (discover) {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&list=categorymembers&cmtitle=${encodeURIComponent("Category:" + discover)}&cmtype=file&cmlimit=50&format=json`;
    const res = await deps.get(url);
    if (!res.ok || !res.body) return console.log(`Could not list the category (HTTP ${res.status}${res.error ? ", " + res.error : ""}).`);
    const names = parseCategoryMembers(JSON.parse(res.body.toString("utf8")));
    console.log(`${names.length} candidate image file(s) in Category:${discover}. Review each licence and picture, then add the ones you want to reference-data/manifest.json:\n`);
    for (const n of names) console.log(`  ${n}\n    page:  https://commons.wikimedia.org/wiki/File:${encodeURIComponent(n)}\n    image: https://commons.wikimedia.org/wiki/Special:Redirect/file/${encodeURIComponent(n)}\n    api:   ${commonsApiUrl(n)}`);
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as Manifest;
  const problems = validateManifest(manifest);
  if (problems.length) {
    console.log("The manifest has problems:\n" + problems.map((p) => "  - " + p).join("\n"));
    process.exit(1);
  }
  const prior = fs.existsSync(path.join(dir, "manifest.resolved.json")) ? (JSON.parse(fs.readFileSync(path.join(dir, "manifest.resolved.json"), "utf8")) as Manifest) : null;
  fs.mkdirSync(path.join(dir, "cache"), { recursive: true });
  const resolved: Manifest = { ...manifest, images: [] };
  for (const entry of manifest.images) {
    // a previously reviewed checksum protects against the source changing the picture
    const before = prior?.images.find((i) => i.id === entry.id)?.checksum ?? entry.checksum;
    const r = await fetchReference({ ...entry, checksum: before ?? null }, deps);
    resolved.images.push(r.entry);
    if (r.body && r.entry.mime) {
      const ext = r.entry.mime === "image/png" ? "png" : r.entry.mime === "image/webp" ? "webp" : "jpg";
      fs.writeFileSync(path.join(dir, "cache", `${entry.id}.${ext}`), r.body);
      const again = await checkImageBytes(fs.readFileSync(path.join(dir, "cache", `${entry.id}.${ext}`)));
      if (again.checksum !== r.entry.checksum) console.log(`  !! ${entry.id}: the saved file does not match its checksum`);
    }
    console.log(`${r.entry.validation.status === "valid" ? "OK  " : "FAIL"} ${entry.id.padEnd(22)} ${r.entry.validation.status}${r.entry.validation.reason ? " - " + r.entry.validation.reason : ""}${r.entry.license ? `  [${r.entry.license}]` : ""}${r.entry.width ? `  ${r.entry.width}x${r.entry.height}` : ""}`);
  }
  fs.writeFileSync(path.join(dir, "manifest.resolved.json"), JSON.stringify(resolved, null, 2));
  const valid = resolved.images.filter((i) => i.validation.status === "valid");
  console.log(`\n${valid.length} of ${resolved.images.length} images valid; ${resolved.images.filter(usableAsReference).length} usable as production references (regression images are never references).`);
  console.log("Coverage against the evaluation targets:");
  for (const t of manifest.coverageTargets) console.log(`  ${t.family}: target ${t.wantImages}. ${t.note}`);
  console.log("Wrote reference-data/manifest.resolved.json. Images are in reference-data/cache/ (not committed).");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
