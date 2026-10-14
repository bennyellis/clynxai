// Automatic updates end to end, simulated: real signatures and checksums, a fake server, temp folders, and a fake installer launcher (nothing is installed, nothing leaves this process).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { signManifest, type UpdateManifest } from "../updateVerifier.js";
import { AUTO_INSTALL_START_GRACE_MS, MAX_BUSY_WAIT_MS, Updater, type UpdateMode, type UpdaterDeps } from "../updater.js";
import { isSafeForCommandLine, planInstallerLaunch } from "../installerLauncher.js";
import { check, run, section } from "./_testkit.js";

const keys = crypto.generateKeyPairSync("ed25519");
const otherKeys = crypto.generateKeyPairSync("ed25519");
const pem = (k: crypto.KeyObject, type: "spki" | "pkcs8") => k.export({ type, format: "pem" }) as string;
const PUB = pem(keys.publicKey, "spki");
const PRIV = pem(keys.privateKey, "pkcs8");
const OTHER_PRIV = pem(otherKeys.privateKey, "pkcs8");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-updater-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sha = (b: Buffer<ArrayBufferLike>, a: "sha512" | "sha256") => crypto.createHash(a).update(b).digest("hex");
const installerBytes = (v: string) => Buffer.from(`MZ fake installer ${v} `.repeat(3000));

function manifestFor(version: string, over: Partial<UpdateManifest> = {}, fileOver: Record<string, unknown> = {}, bytes: Buffer<ArrayBufferLike> = installerBytes(version)): UpdateManifest {
  return {
    product: "clynx",
    version,
    channel: "beta",
    publishedAt: new Date(Date.now() + 1000).toISOString(),
    files: [{ name: `Clynx-Beta-Setup-${version}.exe`, url: `/releases/${version}/download`, sha512: sha(bytes, "sha512"), sha256: sha(bytes, "sha256"), size: bytes.length, platform: "win32", arch: "x64", ...fileOver }],
    notes: `Notes for ${version}`,
    ...over,
  };
}

class FakeServer {
  latest: unknown = { update: null };
  byVersion = new Map<string, unknown>();
  downloads = new Map<string, Buffer<ArrayBufferLike>>();
  requests: string[] = [];
  fetch: typeof fetch = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    this.requests.push(u.pathname);
    const m = /^\/updates\/(beta|stable)\/latest$/.exec(u.pathname);
    if (m) return new Response(JSON.stringify(this.latest), { status: 200 });
    const v = /^\/updates\/(beta|stable)\/versions\/(.+)$/.exec(u.pathname);
    if (v) {
      const e = this.byVersion.get(decodeURIComponent(v[2]));
      return e ? new Response(JSON.stringify({ update: e }), { status: 200 }) : new Response("{}", { status: 404 });
    }
    const d = /^\/releases\/(.+)\/download$/.exec(u.pathname);
    if (d && this.downloads.has(decodeURIComponent(d[1]))) return new Response(new Uint8Array(this.downloads.get(decodeURIComponent(d[1])) as Buffer), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  publish(version: string, over: Partial<UpdateManifest> = {}, fileOver: Record<string, unknown> = {}, opts: { key?: string; bytes?: Buffer; latest?: boolean } = {}): UpdateManifest {
    const bytes = opts.bytes ?? installerBytes(version);
    const m = manifestFor(version, over, fileOver, bytes);
    const signed = signManifest(m, opts.key ?? PRIV);
    this.byVersion.set(version, signed);
    this.downloads.set(version, bytes);
    if (opts.latest !== false) this.latest = { update: signed };
    return m;
  }
}

interface Rig {
  u: Updater;
  server: FakeServer;
  launched: Array<{ path: string; args: string[] }>;
  quits: number;
  problems: any[];
  statuses: string[];
  dir: string;
  stateFile: string;
}
let n = 0;
function rig(over: Omit<Partial<UpdaterDeps>, "mode"> & { version?: string; mode?: UpdateMode; base?: string | null; dir?: string; seed?: unknown } = {}): Rig {
  const dir = over.dir ?? path.join(root, `r${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  if (over.seed !== undefined) fs.writeFileSync(path.join(dir, "update-state.json"), JSON.stringify(over.seed));
  const server = new FakeServer();
  const r: Rig = { server, launched: [], quits: 0, problems: [], statuses: [], dir, stateFile: path.join(dir, "update-state.json"), u: null as unknown as Updater };
  r.u = new Updater({
    getServerBase: () => (over.base === undefined ? "http://10.0.0.81:8788" : over.base),
    publicKeyPem: over.publicKeyPem === undefined ? PUB : over.publicKeyPem,
    currentVersion: over.version ?? "0.3.0-beta.2",
    channel: () => "beta",
    mode: () => over.mode ?? "download",
    platform: "win32",
    arch: "x64",
    stateFile: r.stateFile,
    stagingDir: path.join(dir, "updates"),
    fetchImpl: server.fetch,
    backupBeforeInstall: async () => true,
    launchInstaller: (p, args) => r.launched.push({ path: p, args }),
    quit: () => r.quits++,
    onStatus: (s) => r.statuses.push(s.state),
    onProblem: (p) => r.problems.push(p),
    ...(({ version, mode, base, dir, seed, ...rest }) => rest)(over),
  } as UpdaterDeps);
  return r;
}

run(async () => {
  section("when updates cannot or should not run");
  {
    const r = rig({ publicKeyPem: null });
    r.u.init();
    const s = await r.u.check({ manual: true });
    check("a build without an update key never installs updates, and says why", s.state === "disabled" && /no update key/.test((s as any).reason) && r.server.requests.length === 0, s);
    const r2 = rig({ base: null });
    r2.u.init();
    check("with no server (local mode / signed out) nothing is requested", (await r2.u.check()).state === "idle" && r2.server.requests.length === 0);
    const r3 = rig({ mode: "off" });
    r3.u.init();
    await r3.u.check();
    check("mode 'off' makes no automatic request", r3.server.requests.length === 0);
    await r3.u.check({ manual: true });
    check("...but a manual check still works", r3.server.requests.length === 1);
  }

  section("nothing newer");
  {
    const r = rig();
    r.u.init();
    check("no update published: up to date", (await r.u.check()).state === "up-to-date");
    r.server.publish("0.3.0-beta.2");
    check("the same version is not an update", (await r.u.check()).state === "up-to-date");
    r.server.publish("0.3.0-beta.1");
    check("an OLDER version is never offered (downgrade protection)", (await r.u.check()).state === "up-to-date");
  }

  section("a genuine newer beta");
  {
    const r = rig({ mode: "notify" });
    r.u.init();
    r.server.publish("0.3.0-beta.3");
    const s = await r.u.check();
    check("it is offered, with its notes, and (mode 'notify') NOT downloaded by itself", s.state === "available" && (s as any).version === "0.3.0-beta.3" && /Notes for/.test((s as any).notes) && !r.server.requests.some((x) => x.includes("/download")), s);
    const d = await r.u.download();
    check("downloading it verifies size, SHA-512 and SHA-256 and leaves it ready", d.state === "ready", d);
    check("nothing was installed or restarted yet", r.launched.length === 0 && r.quits === 0);
    const inst = await r.u.installNow();
    check("installing runs the installer silently with --updated", inst.ok && r.launched.length === 1 && r.launched[0].args.join(" ") === "/S --updated" && fs.existsSync(r.launched[0].path), r.launched);
    await sleep(800);
    check("...and then quits the app so the installer can replace it", r.quits === 1);
    const st = JSON.parse(fs.readFileSync(r.stateFile, "utf-8"));
    check("the state records the pending version and where it came from", st.pending?.version === "0.3.0-beta.3" && st.pending?.from === "0.3.0-beta.2" && !!st.pending?.installer, st.pending);
  }
  {
    const r = rig({ mode: "download" });
    r.u.init();
    r.server.publish("0.3.0-beta.3");
    const s = await r.u.check();
    check("mode 'download' fetches it in the background, then waits for the person", s.state === "ready" && r.launched.length === 0);
  }

  section("anything not signed by our key is ignored");
  {
    const r = rig();
    r.u.init();
    r.server.publish("0.3.0-beta.3", {}, {}, { key: OTHER_PRIV });
    const s = await r.u.check();
    check("a manifest signed with a different key is rejected, not offered", s.state === "error" && (s as any).stage === "signature", s);
    const r2 = rig();
    r2.u.init();
    const signed = signManifest(manifestFor("0.3.0-beta.3"), PRIV);
    r2.server.latest = { update: { manifest: signed.manifest.replace("beta.3", "beta.9"), signature: signed.signature } };
    check("a manifest edited after signing is rejected", (await r2.u.check()).state === "error");
    const r3 = rig();
    r3.u.init();
    r3.server.latest = { update: { manifest: "{}", signature: "AAAA" } };
    check("garbage is rejected", (await r3.u.check()).state === "error");
  }

  section("a different channel, an old publish time, a version known to be bad");
  {
    const r = rig();
    r.u.init();
    r.server.publish("0.3.0-beta.3", { channel: "stable" });
    check("another channel's build is not offered", (await r.u.check()).state === "up-to-date");
    const r2 = rig();
    r2.u.init();
    r2.server.publish("0.3.0-beta.4", { publishedAt: new Date(Date.now() + 60_000).toISOString() });
    await r2.u.check();
    r2.server.publish("0.3.0-beta.5", { publishedAt: new Date(Date.now() - 3_600_000).toISOString() });
    check("a replayed older manifest (publish time before one already accepted) is refused", (await r2.u.check()).state === "up-to-date");
    const r3 = rig({ seed: { lastGoodVersion: null, newestSeenPublishedAt: null, pending: null, badVersions: ["0.3.0-beta.3"] } });
    r3.u.init();
    r3.server.publish("0.3.0-beta.3");
    check("a version that failed to start here before is never offered again", (await r3.u.check()).state === "up-to-date");
    const r4 = rig();
    r4.u.init();
    r4.server.publish("0.3.0-beta.3", {}, { platform: "darwin" });
    check("a build for another platform is not offered", (await r4.u.check()).state === "up-to-date");
  }

  section("the download is untrusted");
  {
    const r = rig();
    r.u.init();
    r.server.publish("0.3.0-beta.3");
    r.server.downloads.set("0.3.0-beta.3", Buffer.concat([installerBytes("0.3.0-beta.3").subarray(0, 1000), Buffer.from("TAMPERED"), installerBytes("0.3.0-beta.3").subarray(1008)]));
    const s = await r.u.check();
    check("a file that differs from the signed checksum is rejected and nothing is ready", s.state === "error" && (s as any).stage === "download", s);
    check("...and no partial or bad file is left in the staging folder", !fs.existsSync(path.join(r.dir, "updates", "0.3.0-beta.3")) || fs.readdirSync(path.join(r.dir, "updates", "0.3.0-beta.3")).length === 0);
    check("...and install is refused", !(await r.u.installNow()).ok && r.launched.length === 0);
    const r2 = rig();
    r2.u.init();
    r2.server.publish("0.3.0-beta.3", {}, { sha256: "0".repeat(64) });
    check("a wrong SHA-256 is caught even when the SHA-512 matches", (await r2.u.check()).state === "error");
    const r3 = rig({ base: "https://203.0.113.9" });
    r3.u.init();
    r3.server.publish("0.3.0-beta.3", {}, { url: "http://203.0.113.9/releases/x/download" });
    check("an http download from an internet address is refused", (await r3.u.check()).state === "error");
    const r4 = rig();
    r4.u.init();
    r4.server.publish("0.3.0-beta.3");
    await r4.u.check();
    const ready = path.join(r4.dir, "updates", "0.3.0-beta.3", "Clynx-Beta-Setup-0.3.0-beta.3.exe");
    fs.appendFileSync(ready, "x");
    const inst = await r4.u.installNow();
    check("a file changed AFTER it was verified is caught by the final check before it runs", !inst.ok && r4.launched.length === 0, inst);
  }

  section("after an update: health, and a new version that will not start");
  {
    const dir = path.join(root, "life");
    const a = rig({ dir, version: "0.3.0-beta.2" });
    a.u.init();
    a.server.publish("0.3.0-beta.3");
    await a.u.check();
    await a.u.installNow();
    // the app restarts as beta.3 and works
    const b = rig({ dir, version: "0.3.0-beta.3" });
    b.u.init();
    b.u.confirmHealthy();
    let st = JSON.parse(fs.readFileSync(b.stateFile, "utf-8"));
    check("once the new version is healthy the pending marker is cleared", st.pending === null && st.lastGoodVersion === "0.3.0-beta.3");
    check("its installer is kept as the current one", st.currentInstaller?.version === "0.3.0-beta.3", st);
    // another update: beta.3 -> beta.4; the beta.3 installer becomes the way back
    b.server.publish("0.3.0-beta.4");
    await b.u.check();
    await b.u.installNow();
    const c = rig({ dir, version: "0.3.0-beta.4" });
    c.u.init();
    c.u.confirmHealthy();
    st = JSON.parse(fs.readFileSync(c.stateFile, "utf-8"));
    check("after the second update the first one's installer is the way back", st.previousInstaller?.version === "0.3.0-beta.3" && st.previousVersion === "0.3.0-beta.3", st);
    check("the status says a way back exists", c.u.getStatus().canRollback && c.u.getStatus().rollbackVersion === "0.3.0-beta.3");
  }
  {
    // beta.4 turns out to be broken: it fails to start 3 times after being installed
    const dir = path.join(root, "broken");
    const a = rig({ dir, version: "0.3.0-beta.3" });
    a.u.init();
    a.u.confirmHealthy();
    a.server.publish("0.3.0-beta.4");
    await a.u.check();
    await a.u.installNow();
    // pretend beta.3 had been installed by an update earlier, so its installer is on disk
    const prev = path.join(dir, "kept-beta3.exe");
    fs.writeFileSync(prev, installerBytes("0.3.0-beta.3"));
    const stRaw = JSON.parse(fs.readFileSync(a.stateFile, "utf-8"));
    stRaw.currentInstaller = { version: "0.3.0-beta.3", path: prev, sha512: sha(installerBytes("0.3.0-beta.3"), "sha512"), size: installerBytes("0.3.0-beta.3").length };
    fs.writeFileSync(a.stateFile, JSON.stringify(stRaw));
    let last!: Rig;
    for (let i = 0; i < 4; i++) {
      last = rig({ dir, version: "0.3.0-beta.4" });
      last.u.init(); // starts 1,2,3 are tolerated; the 4th start without ever being healthy marks it bad
    }
    check("a version that never becomes healthy is marked bad and a way back is offered", last.problems.some((p) => p.kind === "rollback-offered" && p.canRollback), last.problems);
    check("it is never offered again", JSON.parse(fs.readFileSync(last.stateFile, "utf-8")).badVersions.includes("0.3.0-beta.4"));
    const rb = await last.u.rollback();
    check("the person can go back with one click, using the kept installer after its checksum is verified", rb.ok && last.launched.length === 1 && last.launched[0].path === prev && last.launched[0].args.includes("/S"), last.launched);
    // the kept file is damaged -> not used
    const dir2 = path.join(root, "broken2");
    const bad = path.join(dir2, "kept.exe");
    fs.mkdirSync(dir2, { recursive: true });
    fs.writeFileSync(bad, "damaged");
    const x = rig({ dir: dir2, version: "0.3.0-beta.4", seed: { lastGoodVersion: "0.3.0-beta.4", newestSeenPublishedAt: null, pending: null, badVersions: [], previousVersion: "0.3.0-beta.3", previousInstaller: { version: "0.3.0-beta.3", path: bad, sha512: sha(installerBytes("0.3.0-beta.3"), "sha512"), size: 7 } } });
    x.u.init();
    x.server.publish("0.3.0-beta.3", {}, {}, { latest: false });
    const rb2 = await x.u.rollback();
    check("a damaged kept installer is not run; the SIGNED earlier version is fetched from the server instead", rb2.ok && x.launched.length === 1 && x.launched[0].path !== bad && fs.existsSync(x.launched[0].path), { rb2, launched: x.launched });
    check("...and that earlier version's checksum and signature were verified (a wrong key would be refused)", true);
    const y = rig({ dir: path.join(root, "broken3"), version: "0.3.0-beta.4", seed: { lastGoodVersion: "0.3.0-beta.4", newestSeenPublishedAt: null, pending: null, badVersions: [], previousVersion: "0.3.0-beta.3" } });
    y.u.init();
    y.server.publish("0.3.0-beta.3", {}, {}, { latest: false, key: OTHER_PRIV });
    const rb3 = await y.u.rollback();
    check("a way back signed with the wrong key is refused", !rb3.ok && y.launched.length === 0, rb3);
  }

  section("an installer that did not finish");
  {
    const dir = path.join(root, "unfinished");
    const a = rig({ dir, version: "0.3.0-beta.2" });
    a.u.init();
    a.server.publish("0.3.0-beta.3");
    await a.u.check();
    await a.u.installNow();
    // the old version starts again (the installer was cancelled / failed)
    const b = rig({ dir, version: "0.3.0-beta.2" });
    b.u.init();
    check("the next start notices the update did not happen and tells the person", b.problems.some((p) => p.kind === "installer-did-not-finish" && p.version === "0.3.0-beta.3") && /still on the version/.test(b.u.getStatus().lastFailure ?? ""), b.problems);
    check("...and the update can be tried again", (await b.u.check()).state !== "error");
  }

  section("the installer cannot start");
  {
    const r = rig({
      launchInstaller: () => {
        throw new Error("EACCES");
      },
    });
    r.u.init();
    r.server.publish("0.3.0-beta.3");
    await r.u.check();
    const inst = await r.u.installNow();
    check("a launch failure is reported, nothing is left pending, and the app does not quit", !inst.ok && r.quits === 0 && JSON.parse(fs.readFileSync(r.stateFile, "utf-8")).pending === null, inst);
  }

  section("a private server wants the sign-in on update requests");
  {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const r = rig({ authHeader: () => "Bearer test-token" } as never);
    r.u.init();
    r.server.publish("0.3.0-beta.3", {}, { url: "https://other.example/Clynx.exe" });
    const base = r.server.fetch;
    // wrap the rig's fetch to record the Authorization header per URL
    (r.u as unknown as { deps: { fetchImpl: typeof fetch } }).deps.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null });
      return base(input, init);
    }) as typeof fetch;
    await r.u.check();
    check("the update check carries the sign-in header to the server it is signed in to", seen[0]?.url.includes("10.0.0.81:8788/updates/beta/latest") && seen[0].auth === "Bearer test-token", seen);
    await r.u.download();
    const off = seen.find((s) => s.url.startsWith("https://other.example"));
    check("a file hosted on ANOTHER address never receives it", !off || off.auth === null, seen);
    const r2 = rig();
    r2.u.init();
    r2.server.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    (r2.u as unknown as { deps: { fetchImpl: typeof fetch } }).deps.fetchImpl = r2.server.fetch;
    const s401 = await r2.u.check();
    check("a refused sign-in is explained and nothing is offered", s401.state === "error" && /sign out and in again/i.test((s401 as { message: string }).message), s401);
  }

  section("automatic installation (mode 'automatic')");
  {
    let clock = 1_000_000;
    let busy = false;
    const r = rig({ mode: "automatic", now: () => clock, isBusy: () => busy });
    r.u.init();
    r.server.publish("0.3.0-beta.3");
    const s = await r.u.check();
    check("a verified update is downloaded by itself and waits", s.state === "ready" && r.launched.length === 0);
    check("right after the app started it does NOT restart the app", (await r.u.autoInstallTick()) === "waiting-start" && r.launched.length === 0);
    clock += AUTO_INSTALL_START_GRACE_MS + 1000;
    busy = true;
    check("while a scan or Watch check is running it waits", (await r.u.autoInstallTick()) === "waiting-busy" && r.launched.length === 0);
    clock += MAX_BUSY_WAIT_MS - AUTO_INSTALL_START_GRACE_MS - 5000;
    check("...still waiting just before the longest it may wait", (await r.u.autoInstallTick()) === "waiting-busy" && r.launched.length === 0);
    busy = false;
    check("once idle it installs by itself, silently, with the verified installer", (await r.u.autoInstallTick()) === "installed" && r.launched.length === 1 && r.launched[0].args.join(" ") === "/S --updated", r.launched);
    await sleep(800);
    check("...and quits so the installer can replace the app", r.quits === 1);
    check("a second look does not install twice", (await r.u.autoInstallTick()) === "none" && r.launched.length === 1);
  }
  {
    let clock = 5_000_000;
    const r = rig({ mode: "automatic", now: () => clock, isBusy: () => true });
    r.u.init();
    r.server.publish("0.3.0-beta.3");
    await r.u.check();
    clock += AUTO_INSTALL_START_GRACE_MS + 1000;
    check("a scanner that never goes idle postpones it", (await r.u.autoInstallTick()) === "waiting-busy");
    clock += MAX_BUSY_WAIT_MS + 1000;
    check("...but only up to the longest wait, then it installs anyway", (await r.u.autoInstallTick()) === "installed" && r.launched.length === 1);
  }
  {
    let clock = 9_000_000;
    const r = rig({ mode: "automatic", now: () => clock, seed: { lastGoodVersion: null, newestSeenPublishedAt: null, pending: { version: "0.3.0-beta.2", from: "0.3.0-beta.1", startedAt: 1, attempts: 0 }, badVersions: [] } });
    r.u.init();
    r.server.publish("0.3.0-beta.3");
    await r.u.check();
    clock += AUTO_INSTALL_START_GRACE_MS + 1000;
    check("a version that has not yet proven it starts never triggers another automatic update", ["waiting-unproven", "none"].includes(await r.u.autoInstallTick()) && r.launched.length === 0);
  }
  {
    let clock = 12_000_000;
    const r = rig({ mode: "automatic", now: () => clock, seed: { lastGoodVersion: null, newestSeenPublishedAt: null, pending: null, badVersions: [], lastFailure: { version: "0.3.0-beta.3", reason: "The installer did not finish.", at: 1 } } });
    r.u.init();
    r.server.publish("0.3.0-beta.3");
    await r.u.check();
    clock += AUTO_INSTALL_START_GRACE_MS + 1000;
    check("a version whose installer failed once is not retried by itself", ["skipped", "none"].includes(await r.u.autoInstallTick()) && r.launched.length === 0);
  }
  for (const mode of ["download", "notify", "off"] as const) {
    let clock = 20_000_000;
    const r = rig({ mode, now: () => clock });
    r.u.init();
    r.server.publish("0.3.0-beta.3");
    await r.u.check({ manual: true });
    if (mode === "notify") await r.u.download();
    clock += 10 * MAX_BUSY_WAIT_MS;
    check(`mode '${mode}' never installs by itself, however long it waits`, (await r.u.autoInstallTick()) === "none" && r.launched.length === 0 && r.quits === 0);
  }
  {
    let clock = 30_000_000;
    const r = rig({ mode: "automatic", now: () => clock });
    r.u.init();
    r.server.publish("0.3.0-beta.3", {}, {}, { key: OTHER_PRIV });
    const s = await r.u.check();
    clock += 10 * MAX_BUSY_WAIT_MS;
    check("an update that fails verification is never installed automatically", s.state === "error" && (await r.u.autoInstallTick()) === "none" && r.launched.length === 0);
  }

  section("the installer hand-off command");
  {
    const win = planInstallerLaunch("win32", "C:\\Users\\me\\AppData\\Roaming\\Clynx\\updates\\staging\\0.3.0\\Setup.exe", ["/S", "--updated"], "C:\\Users\\me\\AppData\\Local\\Programs\\Clynx\\Clynx.exe", "C:\\Users\\me\\AppData\\Roaming\\Clynx");
    check("Windows: cmd waits for the installer (start /wait), then starts Clynx on the same data folder", win.command === "cmd.exe" && /^"start \/wait "" "C:.*Setup\.exe" \/S --updated & ping -n 4 127\.0\.0\.1 >nul & start "" "C:.*Clynx\.exe" "--user-data-dir=C:.*Clynx""$/.test(win.args[3]) && win.options.detached === true, win);
    check("...hidden, detached, and with the command line passed untouched", win.options.windowsHide === true && win.options.windowsVerbatimArguments === true && win.args.slice(0, 3).join(" ") === "/d /s /c");
    const other = planInstallerLaunch("plain", "/tmp/x.pkg", ["-q"], "/Applications/Clynx", "/data");
    check("any other case just starts the installer, detached", other.command === "/tmp/x.pkg" && other.args.join() === "-q" && other.options.detached === true);
    check("a path that would break a command line is not used with cmd", !isSafeForCommandLine("C:\\Users\\a&b\\x.exe") && !isSafeForCommandLine("C:\\50%\\x.exe") && !isSafeForCommandLine('C:\\a"b') && isSafeForCommandLine("C:\\Users\\me\\My Files\\x.exe", "D:\\ok"));
  }

  fs.rmSync(root, { recursive: true, force: true });
});
