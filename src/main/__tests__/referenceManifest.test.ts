// The reference image pipeline: licences from the source's API, byte-level verification, unavailable/changed sources, and the reference/regression split. Synthetic images and a fake
// network exercise the PIPELINE; they say nothing about whether the real Commons files are good references (scripts/reference-fetch.cjs checks that on a connected machine).
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { ACCEPTED_LICENSES, checkImageBytes, commonsFileName, fetchReference, licenseAccepted, parseCategoryMembers, parseCommonsInfo, sha256, sniffMime, usableAsReference, validateManifest, type Downloaded, type FetchDeps, type Manifest, type ManifestImage } from "../referenceManifest.js";
import { check, run, section } from "./_testkit.js";

const img = async (w: number, h: number, fmt: "png" | "jpeg" = "png"): Promise<Buffer> => sharp({ create: { width: w, height: h, channels: 3, background: "#3366aa" } })[fmt]().toBuffer();
const commons = (license: string | null, artist: string | null = "A Photographer") =>
  Buffer.from(JSON.stringify({ query: { pages: { "1": { title: "File:X.jpg", imageinfo: [{ url: "https://upload.wikimedia.org/x.jpg", descriptionurl: "https://commons.wikimedia.org/wiki/File:X.jpg", mime: "image/jpeg", width: 800, height: 600, extmetadata: { LicenseShortName: { value: license }, Artist: { value: artist ? `<a href="u">${artist}</a>` : "" }, Credit: { value: "" } } }] } } } }));
const entry = (over: Partial<ManifestImage> = {}): ManifestImage => ({
  id: "t1", role: "reference", family: "Nintendo 3DS family", model: "New Nintendo 3DS XL", variant: null, edition: null,
  sourcePageUrl: "https://commons.wikimedia.org/wiki/File:X.jpg", imageUrl: "https://commons.wikimedia.org/wiki/Special:Redirect/file/X.jpg",
  license: null, attribution: null, licenseUrl: null, expectedFeatures: ["a console"], expectedAnswers: {}, cameraAngle: "front", reliability: "reference_photo", knownLookalikes: [],
  checksum: null, width: null, height: null, mime: null, bytes: null, validation: { status: "pending" }, suppliedBy: "test", ...over,
});
function net(meta: Downloaded, file: Downloaded): FetchDeps & { urls: string[] } {
  const urls: string[] = [];
  return { urls, get: async (u) => (urls.push(u), u.includes("api.php") ? meta : file) };
}

run(async () => {
  section("licences");
  check("CC BY, CC BY-SA, CC0 and public domain are accepted", ["CC BY 4.0", "CC BY-SA 3.0", "CC BY-SA 4.0", "CC0 1.0", "Public domain", "CC-BY-2.0"].every((l) => licenseAccepted(l)), ["CC BY 4.0", "CC BY-SA 3.0", "CC0 1.0"].map(licenseAccepted));
  check("NonCommercial, NoDerivs, unknown and empty licences are rejected", !licenseAccepted("CC BY-NC 4.0") && !licenseAccepted("CC BY-ND 2.0") && !licenseAccepted("All rights reserved") && !licenseAccepted("") && !licenseAccepted(null));
  void ACCEPTED_LICENSES;

  section("the source's own metadata");
  const info = parseCommonsInfo(JSON.parse(commons("CC BY-SA 4.0").toString()));
  check("licence, author and size are read from the API answer (markup removed)", info?.license === "CC BY-SA 4.0" && info.artist === "A Photographer" && info.width === 800);
  check("a missing file page reads as nothing", parseCommonsInfo({ query: { pages: { "-1": { title: "File:Nope.jpg", missing: "" } } } }) === null);
  check("the file name comes from the page address", commonsFileName("https://commons.wikimedia.org/wiki/File:New_Nintendo_3DS_XL_-_open.jpg") === "New_Nintendo_3DS_XL_-_open.jpg");
  check("category members are image files only", parseCategoryMembers({ query: { categorymembers: [{ title: "File:A.jpg" }, { title: "File:B.ogv" }, { title: "Category:X" }, { title: "File:C.PNG" }] } }).join() === "A.jpg,C.PNG");

  section("bytes decide, not names");
  check("the first bytes name the type", sniffMime(await img(8, 8)) === "image/png" && sniffMime(await img(8, 8, "jpeg")) === "image/jpeg" && sniffMime(Buffer.from("<html>")) === null);
  const good = await img(640, 480);
  const ok = await checkImageBytes(good, "image/png");
  check("a real image is valid, with size and checksum", ok.status === "valid" && ok.width === 640 && ok.checksum === sha256(good));
  check("a JPEG served with the wrong content type is still read as what it is", (await checkImageBytes(await img(640, 480, "jpeg"), "text/html")).status === "valid");
  check("an HTML error page served as 200 is invalid and says what it was", (await checkImageBytes(Buffer.from("<html><body>Rate limited</body></html>"), "text/html")).status === "invalid");
  check("a tiny image is too small to recognise details", (await checkImageBytes(await img(60, 60))).status === "invalid");
  check("a damaged file is invalid", (await checkImageBytes(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("garbage not a png")]))).status === "invalid");
  check("an empty response is invalid", (await checkImageBytes(Buffer.alloc(0))).status === "invalid");

  section("one image end to end");
  const goodNet = net({ ok: true, status: 200, body: commons("CC BY-SA 4.0") }, { ok: true, status: 200, contentType: "image/jpeg", body: good });
  const f1 = await fetchReference(entry(), goodNet);
  check("a licensed, decodable image is valid, with licence, attribution, checksum and bytes to store", f1.entry.validation.status === "valid" && f1.entry.license === "CC BY-SA 4.0" && f1.entry.attribution === "A Photographer" && !!f1.entry.checksum && !!f1.body);
  check("the licence was looked up before the file was downloaded", goodNet.urls[0].includes("api.php") && !goodNet.urls[0].includes("Special:Redirect"));
  const f2 = await fetchReference(entry(), net({ ok: true, status: 200, body: commons("CC BY-NC 4.0") }, { ok: true, status: 200, body: good }));
  check("a NonCommercial image is not downloaded or stored", f2.entry.validation.status === "license_rejected" && !f2.body);
  const f3 = await fetchReference(entry(), net({ ok: true, status: 200, body: commons("CC BY 4.0", null) }, { ok: true, status: 200, body: good }));
  check("no readable author means no attribution, so no storage", f3.entry.validation.status === "license_rejected" && /attribution/.test(f3.entry.validation.reason ?? ""));
  const f4 = await fetchReference(entry(), net({ ok: true, status: 200, body: commons("CC BY 4.0") }, { ok: false, status: 404 }));
  check("a missing file is reported as unavailable", f4.entry.validation.status === "unavailable" && /404/.test(f4.entry.validation.reason ?? ""));
  const f5 = await fetchReference(entry(), net({ ok: false, status: 0, error: "fetch failed" }, { ok: false, status: 0 }));
  check("no network is reported, not hidden", f5.entry.validation.status === "unavailable" && /metadata/.test(f5.entry.validation.reason ?? ""));
  const f6 = await fetchReference(entry({ checksum: "0".repeat(64) }), goodNet);
  check("a source that now serves a different picture is flagged 'changed' and not stored", f6.entry.validation.status === "changed" && !f6.body);
  const f7 = await fetchReference(entry(), net({ ok: true, status: 200, body: commons("CC BY 4.0") }, { ok: true, status: 200, contentType: "text/html", body: Buffer.from("<html>blocked</html>") }));
  check("an HTML page instead of the image is invalid", f7.entry.validation.status === "invalid" && !f7.body);
  const f8 = await fetchReference(entry({ sourcePageUrl: "https://example.com/photo", license: null }), goodNet);
  check("a non-Commons image with no licence in the manifest is refused", f8.entry.validation.status === "license_rejected");
  const f9 = await fetchReference(entry({ sourcePageUrl: "https://example.com/photo", license: "CC BY 4.0", attribution: "Me" }), goodNet);
  check("a non-Commons image with its licence and attribution written in the manifest is accepted", f9.entry.validation.status === "valid");

  section("reference vs regression");
  check("a valid, licensed reference image is usable in production", usableAsReference(f1.entry));
  check("a regression image never is, however valid", !usableAsReference({ ...f1.entry, role: "regression" }));
  check("an unverified-reliability or unlicensed image never is", !usableAsReference({ ...f1.entry, reliability: "unverified" }) && !usableAsReference({ ...f1.entry, license: null }) && !usableAsReference(f2.entry));

  section("the real manifest file");
  const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "reference-data", "manifest.json"), "utf8")) as Manifest;
  check("it is structurally valid with unique ids", validateManifest(manifest).length === 0, validateManifest(manifest));
  check("it carries the owner's four Commons images and the official/catalogue documents", manifest.images.length === 4 && manifest.documents.length >= 9);
  check("the side-by-side comparison is a regression image, never a reference, and marked as two products", manifest.images.find((i) => i.id === "3dsxl-vs-new-front")?.role === "regression" && manifest.images.find((i) => i.id === "3dsxl-vs-new-front")?.multipleProducts === true);
  check("no image claims a licence before it has been read from the source", manifest.images.every((i) => i.license === null && i.checksum === null && i.validation.status === "pending"));
  check("unmet coverage targets are stated, not hidden", manifest.coverageTargets.length >= 5 && manifest.coverageTargets.every((t) => t.note.length > 20));
  check("a broken manifest is caught", validateManifest({ version: 1, images: [{ id: "a" }, { id: "a" }], documents: [] }).length >= 3);
  const cases = JSON.parse(fs.readFileSync(path.join(process.cwd(), "reference-data", "cases.json"), "utf8")) as { cases: Array<{ id: string; imageIds?: string[]; needsImages?: boolean }> };
  check("every case that names images names images that exist; planned ones say they need images", cases.cases.every((c) => c.needsImages || !c.imageIds || c.imageIds.every((id) => manifest.images.some((i) => i.id === id))));
});
