// Phase 7: signed-update core - signature, replay/downgrade protection, hash-checked download, and rollback after repeated failed starts.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EMPTY_UPDATE_STATE,
  compareVersions,
  downloadAndVerify,
  evaluateOffer,
  markHealthy,
  markInstalled,
  onAppStart,
  readUpdateState,
  recordAccepted,
  signManifest,
  verifyManifest,
  writeUpdateState,
  type UpdateManifest,
} from "../updateVerifier.js";
import { check, run, section } from "./_testkit.js";

const keys = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { pub: publicKey.export({ type: "spki", format: "pem" }).toString(), priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
};
const payload = Buffer.from("pretend installer bytes ".repeat(500));
const sha = crypto.createHash("sha512").update(payload).digest("hex");
const manifest = (over: Partial<UpdateManifest> = {}): UpdateManifest => ({
  product: "clynx",
  version: "0.3.0",
  channel: "stable",
  publishedAt: "2026-10-01T00:00:00Z",
  files: [{ name: "Clynx-Setup-0.3.0.exe", url: "https://dl.example/Clynx-Setup-0.3.0.exe", sha512: sha, size: payload.length, platform: "win32", arch: "x64" }],
  ...over,
});
async function* chunks(b: Buffer, size = 700) {
  for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size);
}
const fresh = () => ({ ...EMPTY_UPDATE_STATE, badVersions: [] as string[] });
const ctx = (over = {}) => ({ currentVersion: "0.2.0", channel: "stable", platform: "win32", arch: "x64", state: fresh(), ...over });

run(async () => {
  const k = keys();
  const other = keys();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-upd-"));

  section("signature");
  {
    const signed = signManifest(manifest(), k.priv);
    check("a correctly signed manifest verifies", verifyManifest(signed, k.pub).ok === true);
    check("a different key is refused", verifyManifest(signed, other.pub).ok === false);
    const tampered = { ...signed, manifest: signed.manifest.replace("0.3.0", "9.9.9") };
    check("a changed manifest is refused", verifyManifest(tampered, k.pub).ok === false);
    check("a changed signature is refused", verifyManifest({ ...signed, signature: Buffer.from("x".repeat(64)).toString("base64") }, k.pub).ok === false);
    check("malformed input is refused without throwing", [null, {}, "x", { manifest: 1, signature: 2 }, { manifest: "{}", signature: "AAAA" }].every((v) => verifyManifest(v, k.pub).ok === false));
    const bad = signManifest({ ...manifest(), files: [{ ...manifest().files[0], sha512: "abc" }] }, k.priv);
    check("a signed manifest with a malformed checksum is still refused", verifyManifest(bad, k.pub).ok === false);
    const badVersion = signManifest(manifest({ version: "latest" }), k.priv);
    check("a signed manifest with a nonsense version is refused", verifyManifest(badVersion, k.pub).ok === false);
  }

  section("versions and offers");
  {
    check("version ordering", compareVersions("0.2.0", "0.10.0") < 0 && compareVersions("1.0.0", "0.99.99") > 0 && compareVersions("1.2.3", "1.2.3") === 0 && compareVersions("1.2.3-beta", "1.2.3") < 0 && compareVersions("0.3.0-beta.2", "0.3.0-beta.1") > 0 && compareVersions("0.3.0-beta.10", "0.3.0-beta.9") > 0 && compareVersions("0.3.1-beta.1", "0.3.0") > 0); // a pre-release is OLDER than its release (the beta channel depends on this)
    const m = manifest();
    check("a newer version for this platform is offered", evaluateOffer(m, ctx()).offer === true);
    check("the same or an older version is not offered (no downgrade)", !evaluateOffer(manifest({ version: "0.2.0" }), ctx()).offer && !evaluateOffer(manifest({ version: "0.1.0" }), ctx()).offer);
    check("another channel is not offered", !evaluateOffer(manifest({ channel: "beta" }), ctx()).offer);
    check("no build for this computer is not offered", !evaluateOffer(m, ctx({ platform: "darwin" })).offer);
    const seen = recordAccepted(fresh(), manifest({ publishedAt: "2026-10-05T00:00:00Z" }));
    check("an older signed manifest cannot be replayed after a newer one was seen", !evaluateOffer(manifest({ publishedAt: "2026-10-01T00:00:00Z" }), ctx({ state: seen })).offer);
    check("a version that failed to start is never offered again", !evaluateOffer(m, ctx({ state: { ...fresh(), badVersions: ["0.3.0"] } })).offer);
  }

  section("download");
  {
    const file = manifest().files[0];
    const ok = await downloadAndVerify(file, path.join(dir, "ok"), async () => chunks(payload));
    check("a matching download is kept", ok.ok && fs.readFileSync((ok as { path: string }).path).equals(payload));
    const wrong = Buffer.from(payload);
    wrong[10] ^= 0xff;
    const r1 = await downloadAndVerify(file, path.join(dir, "bad"), async () => chunks(wrong));
    check("a download with a wrong checksum is refused and nothing is left behind", !r1.ok && fs.readdirSync(path.join(dir, "bad")).length === 0, r1);
    const r2 = await downloadAndVerify(file, path.join(dir, "short"), async () => chunks(payload.subarray(0, 100)));
    check("a truncated download is refused", !r2.ok && fs.readdirSync(path.join(dir, "short")).length === 0);
    const r3 = await downloadAndVerify(file, path.join(dir, "long"), async () => chunks(Buffer.concat([payload, Buffer.from("extra")])));
    check("a download longer than signed is refused", !r3.ok && fs.readdirSync(path.join(dir, "long")).length === 0);
    const r4 = await downloadAndVerify({ ...file, url: "http://dl.example/x.exe" }, path.join(dir, "http"), async () => chunks(payload));
    check("plain http is refused", !r4.ok);
    const r5 = await downloadAndVerify({ ...file, name: "..\\..\\evil.exe" }, path.join(dir, "trav"), async () => chunks(payload));
    check("a file name cannot escape the staging folder", r5.ok && path.dirname((r5 as { path: string }).path) === path.join(dir, "trav"), r5);
    const dropped = async () =>
      (async function* () {
        yield payload.subarray(0, 50);
        throw new Error("connection reset");
      })();
    const r6 = await downloadAndVerify(file, path.join(dir, "err"), dropped);
    check("a dropped connection is refused cleanly", !r6.ok);
  }

  section("rollback after failed starts");
  {
    let s = markInstalled({ ...fresh(), lastGoodVersion: "0.2.0" }, "0.3.0");
    const a = onAppStart(s, "0.3.0");
    check("the first start of a new version is allowed", a.action === "none" && a.state.pending?.startsSinceInstall === 1);
    s = markHealthy(a.state, "0.3.0");
    check("once healthy it becomes the last good version and the marker clears", s.lastGoodVersion === "0.3.0" && s.pending === null);

    let t = markInstalled({ ...fresh(), lastGoodVersion: "0.2.0" }, "0.4.0");
    const actions: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = onAppStart(t, "0.4.0");
      actions.push(r.action);
      t = r.state;
    }
    check("a version that never gets healthy is rolled back on the 4th start and recorded as bad", actions.join() === "none,none,none,rollback" && t.badVersions.includes("0.4.0") && t.pending === null, { actions, t });
    check("running the old version after a rollback just clears the marker", onAppStart(markInstalled(fresh(), "0.5.0"), "0.2.0").state.pending === null);

    const file = path.join(dir, "state", "update-state.json");
    writeUpdateState(file, t);
    const reread = readUpdateState(file);
    check("state survives a restart", reread.lastGoodVersion === t.lastGoodVersion && reread.pending === t.pending && JSON.stringify(reread.badVersions) === JSON.stringify(t.badVersions) && reread.newestSeenPublishedAt === t.newestSeenPublishedAt);
    fs.writeFileSync(file, "{ not json");
    check("a damaged state file reads as empty, not as a crash", readUpdateState(file).lastGoodVersion === null);
  }

  fs.rmSync(dir, { recursive: true, force: true });
});
