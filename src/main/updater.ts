// Automatic desktop updates: check the signed-in server for a newer SIGNED build, download it in the background, and (only when the person says so) install it and restart.
//
// What is trusted, and what is not:
//   * The server is NOT trusted. It hands over a manifest signed with the update key; this app holds only the PUBLIC half (resources/update-public.pem) and refuses anything whose
//     signature does not verify, that is for another channel/platform, that is not newer than the running version, or whose publish time is older than one already accepted.
//   * The downloaded installer is NOT trusted either: it is used only if its size, SHA-512 and SHA-256 equal what the signed manifest states, and is hashed again right before it runs.
//   * Nothing installs without the person's click ("Restart and install"). User data (Database, settings, Facebook profile, keys) lives outside the install folder and is never touched
//     by the installer; a Database backup is made first anyway.
//   * Signature checks cannot be switched off. A build without the public key simply cannot install updates (manual installers keep working).
// Failure handling: an installer that did not finish is detected on the next start; a new version that fails to start 3 times is marked bad, never offered again, and (when the installer
// of the previous version is still on this computer) the person is offered a one-click way back. Pure of Electron so it can be tested; src/main/index.ts wires the real pieces in.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  compareVersions,
  downloadAndVerify,
  evaluateOffer,
  markHealthy,
  markInstalled,
  onAppStart,
  readUpdateState,
  recordAccepted,
  verifyManifest,
  writeUpdateState,
  type InstallerRecord,
  type UpdateFile,
  type UpdateManifest,
  type UpdateState,
} from "./updateVerifier.js";

export type UpdateMode = "off" | "notify" | "download";
export type UpdateChannel = "beta" | "stable";

export type UpdateStatus =
  | { state: "disabled"; reason: string }
  | { state: "idle" }
  | { state: "checking" }
  | { state: "up-to-date"; checkedAt: number }
  | { state: "available"; version: string; notes: string; size: number; publishedAt: string }
  | { state: "downloading"; version: string; received: number; total: number }
  | { state: "ready"; version: string; notes: string }
  | { state: "installing"; version: string }
  | { state: "error"; message: string; stage: "check" | "signature" | "download" | "install" | "rollback" };

export interface UpdateInfo {
  status: UpdateStatus;
  currentVersion: string;
  channel: UpdateChannel;
  mode: UpdateMode;
  lastCheckedAt: number | null;
  canRollback: boolean;
  rollbackVersion: string | null;
  lastFailure: string | null;
  enabled: boolean;
  badVersions: string[];
}

export interface UpdaterDeps {
  /** The signed-in server's address, or null when there is no server (local mode, signed out): then nothing is checked. */
  getServerBase: () => string | null;
  /** The public half of the update signing key. Null: this build cannot verify updates, so it does not install any. */
  publicKeyPem: string | null;
  currentVersion: string;
  channel: () => UpdateChannel;
  mode: () => UpdateMode;
  platform: string;
  arch: string;
  stateFile: string;
  stagingDir: string;
  fetchImpl?: typeof fetch;
  /** Copies the user's data aside before an install (best effort; its result is reported, not required). */
  backupBeforeInstall?: () => Promise<boolean>;
  /** Starts the installer and returns; the app is quit by `quit` right after. */
  launchInstaller: (installerPath: string, args: string[]) => void;
  quit: () => void;
  onStatus?: (s: UpdateStatus) => void;
  /** Called when something needs the person's attention (a failed update, a version that will not start). */
  onProblem?: (p: { kind: "installer-did-not-finish" | "rollback-offered"; version: string; message: string; canRollback: boolean }) => void;
  log?: (msg: string) => void;
  now?: () => number;
}

const hashFile = (file: string, algorithm: "sha512" | "sha256"): string => crypto.createHash(algorithm).update(fs.readFileSync(file)).digest("hex");

export class Updater {
  private state: UpdateState;
  private status: UpdateStatus = { state: "idle" };
  private offered: { manifest: UpdateManifest; file: UpdateFile } | null = null;
  private readyPath: string | null = null;
  private busy = false;
  private lastCheckedAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;

  constructor(private deps: UpdaterDeps) {
    this.now = deps.now ?? Date.now;
    this.state = readUpdateState(deps.stateFile);
  }

  private save(): void {
    try {
      writeUpdateState(this.deps.stateFile, this.state);
    } catch (err) {
      this.deps.log?.(`[updates] could not save update state: ${err instanceof Error ? err.message : err}`);
    }
  }
  private set(s: UpdateStatus): void {
    this.status = s;
    this.deps.onStatus?.(s);
  }
  private log(m: string): void {
    this.deps.log?.(`[updates] ${m}`);
  }

  /** The way back, if one exists on this computer: the installer of the version before this one (or, if this version never proved healthy, the version it replaced). */
  private rollbackCandidate(): InstallerRecord | null {
    const c = this.state.pending ? this.state.currentInstaller : this.state.previousInstaller;
    return c && fs.existsSync(c.path) && compareVersions(c.version, this.deps.currentVersion) !== 0 ? c : null;
  }
  /** The version a way back leads to (known even when its installer is no longer on this computer: it can be fetched from the server, signed). */
  private rollbackTarget(): string | null {
    const v = this.state.pending ? this.state.pending.from : this.state.previousVersion;
    return v && compareVersions(v, this.deps.currentVersion) !== 0 ? v : null;
  }

  getStatus(): UpdateInfo {
    const r = this.rollbackCandidate();
    const target = r?.version ?? this.rollbackTarget();
    return {
      status: this.status,
      currentVersion: this.deps.currentVersion,
      channel: this.deps.channel(),
      mode: this.deps.mode(),
      lastCheckedAt: this.lastCheckedAt,
      canRollback: !!target && (!!r || !!this.deps.getServerBase()),
      rollbackVersion: target,
      lastFailure: this.state.lastFailure ? `${this.state.lastFailure.reason} (update to ${this.state.lastFailure.version})` : null,
      enabled: !!this.deps.publicKeyPem,
      badVersions: this.state.badVersions,
    };
  }

  /** Call once at every start of the app. Detects an installer that did not finish and a new version that keeps failing to start. */
  init(): void {
    const before = this.state;
    const r = onAppStart(this.state, this.deps.currentVersion);
    this.state = r.state;
    if (r.action === "rollback" && before.pending) {
      // the failing version no longer counts as pending, but the way back (what it replaced) must stay known
      this.state = { ...this.state, previousInstaller: before.currentInstaller ?? this.state.previousInstaller ?? null, previousVersion: before.pending.from ?? this.state.previousVersion ?? null };
    }
    this.save();
    if (!this.deps.publicKeyPem) this.set({ state: "disabled", reason: "This build of Clynx has no update key, so it cannot install updates by itself. Download new versions from the website." });
    if (this.state.lastFailure && !before.lastFailure) {
      this.deps.onProblem?.({ kind: "installer-did-not-finish", version: this.state.lastFailure.version, message: this.state.lastFailure.reason, canRollback: false });
    }
    if (r.action === "rollback") {
      const target = this.rollbackCandidate()?.version ?? this.rollbackTarget();
      const can = !!target;
      this.log(`version ${this.deps.currentVersion} failed to start repeatedly: marked bad${can ? "; a way back is available" : ""}`);
      this.deps.onProblem?.({
        kind: "rollback-offered",
        version: this.deps.currentVersion,
        canRollback: can,
        message: can ? `Clynx ${this.deps.currentVersion} had trouble starting. You can go back to ${target}; your data is not affected.` : `Clynx ${this.deps.currentVersion} had trouble starting and will not be offered again. Install the previous version from the website's Download page; your data is not affected.`,
      });
    }
  }

  /** Call when the running version has proved itself (window up, database open, a couple of minutes alive). */
  confirmHealthy(): void {
    this.state = markHealthy(this.state, this.deps.currentVersion);
    this.save();
    this.cleanStaging();
  }

  private cleanStaging(): void {
    try {
      const keep = new Set([this.state.currentInstaller?.path, this.state.previousInstaller?.path, this.state.pending?.installer?.path, this.readyPath].filter(Boolean) as string[]);
      for (const dir of fs.existsSync(this.deps.stagingDir) ? fs.readdirSync(this.deps.stagingDir) : []) {
        const full = path.join(this.deps.stagingDir, dir);
        if (!fs.statSync(full).isDirectory()) continue;
        const files = fs.readdirSync(full).map((f) => path.join(full, f));
        if (!files.some((f) => keep.has(f))) fs.rmSync(full, { recursive: true, force: true });
      }
    } catch {
      /* cleanup is best effort */
    }
  }

  // ---------------------------------------------------------------- checking
  async check(opts: { manual?: boolean } = {}): Promise<UpdateStatus> {
    if (this.busy) return this.status;
    if (!this.deps.publicKeyPem) {
      this.set({ state: "disabled", reason: "This build of Clynx has no update key, so it cannot install updates by itself. Download new versions from the website." });
      return this.status;
    }
    const base = this.deps.getServerBase();
    if (!base) {
      if (opts.manual) this.set({ state: "error", stage: "check", message: "Sign in to a Clynx server to check for updates." });
      return this.status;
    }
    if (this.deps.mode() === "off" && !opts.manual) return this.status;
    this.busy = true;
    this.set({ state: "checking" });
    try {
      const channel = this.deps.channel();
      const doFetch = this.deps.fetchImpl ?? fetch;
      const url = `${base.replace(/\/+$/, "")}/updates/${channel}/latest?platform=${encodeURIComponent(this.deps.platform)}&arch=${encodeURIComponent(this.deps.arch)}`;
      let res: Response;
      try {
        res = await doFetch(url, { signal: AbortSignal.timeout(15_000), redirect: "error", headers: { Accept: "application/json" } });
      } catch {
        this.set({ state: "error", stage: "check", message: "Could not reach the server to check for updates. It will try again later." });
        return this.status;
      }
      if (res.status === 404) {
        this.lastCheckedAt = this.now();
        this.set({ state: "up-to-date", checkedAt: this.lastCheckedAt }); // an older server without update support
        return this.status;
      }
      if (!res.ok) {
        this.set({ state: "error", stage: "check", message: `The server could not check for updates (error ${res.status}).` });
        return this.status;
      }
      const body = (await res.json().catch(() => null)) as { update?: unknown } | null;
      this.lastCheckedAt = this.now();
      if (!body || body.update === null || body.update === undefined) {
        this.set({ state: "up-to-date", checkedAt: this.lastCheckedAt });
        return this.status;
      }
      const verified = verifyManifest(body.update, this.deps.publicKeyPem);
      if (!verified.ok) {
        this.log(`REJECTED an update from the server: ${verified.reason}`);
        this.set({ state: "error", stage: "signature", message: `An update was offered, but it could not be verified (${verified.reason}) so it was ignored.` });
        return this.status;
      }
      const m = verified.manifest;
      const offer = evaluateOffer(m, { currentVersion: this.deps.currentVersion, channel, platform: this.deps.platform, arch: this.deps.arch, state: this.state });
      if (!offer.offer || !offer.file) {
        this.set({ state: "up-to-date", checkedAt: this.lastCheckedAt });
        return this.status;
      }
      this.state = recordAccepted(this.state, m);
      this.save();
      this.offered = { manifest: m, file: offer.file };
      // a previously downloaded and verified copy is still there
      const existing = path.join(this.deps.stagingDir, m.version, path.basename(offer.file.name).replace(/[^A-Za-z0-9._-]/g, "_"));
      if (fs.existsSync(existing) && fs.statSync(existing).size === offer.file.size && hashFile(existing, "sha512") === offer.file.sha512) {
        this.readyPath = existing;
        this.set({ state: "ready", version: m.version, notes: m.notes ?? "" });
        return this.status;
      }
      this.set({ state: "available", version: m.version, notes: m.notes ?? "", size: offer.file.size, publishedAt: m.publishedAt });
    } finally {
      this.busy = false;
    }
    if (this.deps.mode() === "download") await this.download();
    return this.status;
  }

  // ---------------------------------------------------------------- downloading
  async download(): Promise<UpdateStatus> {
    const o = this.offered;
    const base = this.deps.getServerBase();
    if (!o || !base) return this.status;
    if (this.busy) return this.status;
    this.busy = true;
    try {
      const doFetch = this.deps.fetchImpl ?? fetch;
      // a relative address (the server's own download route) is resolved against the server we are signed in to; an absolute one must be https
      const url = new URL(o.file.url, base).toString();
      const file: UpdateFile = { ...o.file, url };
      this.set({ state: "downloading", version: o.manifest.version, received: 0, total: o.file.size });
      const stage = path.join(this.deps.stagingDir, o.manifest.version);
      const result = await downloadAndVerify(
        file,
        stage,
        async (u) => {
          const res = await doFetch(u, { redirect: "error", signal: AbortSignal.timeout(30 * 60_000) });
          if (!res.ok || !res.body) throw new Error(`The server answered ${res.status} for the download.`);
          return res.body as unknown as AsyncIterable<Uint8Array>;
        },
        {
          allowLocalNetworkHttp: true,
          onProgress: (received, total) => {
            if (received === total || received % (4 * 1024 * 1024) < 65536) this.set({ state: "downloading", version: o.manifest.version, received, total });
          },
        }
      );
      if (!result.ok) {
        this.log(`download failed: ${result.reason}`);
        this.set({ state: "error", stage: "download", message: `The update could not be downloaded safely (${result.reason}). Nothing was installed.` });
        return this.status;
      }
      this.readyPath = result.path;
      this.set({ state: "ready", version: o.manifest.version, notes: o.manifest.notes ?? "" });
      return this.status;
    } finally {
      this.busy = false;
    }
  }

  // ---------------------------------------------------------------- installing (only ever on the person's click)
  async installNow(): Promise<{ ok: boolean; error?: string }> {
    const o = this.offered;
    if (this.status.state !== "ready" || !o || !this.readyPath) return { ok: false, error: "There is no downloaded update to install." };
    if (!fs.existsSync(this.readyPath) || hashFile(this.readyPath, "sha512") !== o.file.sha512 || (o.file.sha256 && hashFile(this.readyPath, "sha256") !== o.file.sha256)) {
      this.readyPath = null;
      this.set({ state: "error", stage: "install", message: "The downloaded update no longer matches its signed checksum, so it was not installed. Check for updates again." });
      return { ok: false, error: "The downloaded file failed its final check." };
    }
    return this.runInstaller(this.readyPath, { version: o.manifest.version, path: this.readyPath, sha512: o.file.sha512, size: o.file.size }, "install");
  }

  /** One-click way back to the previous version's installer (kept from the update that brought this version). Its checksum is verified again first. */
  async rollback(): Promise<{ ok: boolean; error?: string }> {
    const c = this.rollbackCandidate();
    if (c) {
      if (hashFile(c.path, "sha512") === c.sha512) {
        this.state = { ...this.state, badVersions: [...new Set([...this.state.badVersions, this.deps.currentVersion])] };
        return this.runInstaller(c.path, c, "rollback");
      }
      this.log("the kept copy of the earlier version is damaged; trying the server instead");
    }
    return this.rollbackFromServer();
  }

  // The kept installer is gone: fetch the earlier version's SIGNED manifest from the server (an explicit, person-approved step: the usual "newer than the running version" rule is
  // the one thing waived), verify it exactly like an update, download and verify the installer, and run it.
  private async rollbackFromServer(): Promise<{ ok: boolean; error?: string }> {
    const target = this.rollbackTarget();
    const base = this.deps.getServerBase();
    if (!target || !base || !this.deps.publicKeyPem) return { ok: false, error: "There is no earlier version to go back to. Download the previous installer from the website." };
    if (this.busy) return { ok: false, error: "Another update step is running." };
    this.busy = true;
    try {
      const doFetch = this.deps.fetchImpl ?? fetch;
      const url = `${base.replace(/\/+$/, "")}/updates/${this.deps.channel()}/versions/${encodeURIComponent(target)}?platform=${encodeURIComponent(this.deps.platform)}&arch=${encodeURIComponent(this.deps.arch)}`;
      let body: { update?: unknown } | null = null;
      try {
        const res = await doFetch(url, { signal: AbortSignal.timeout(15_000), redirect: "error" });
        body = res.ok ? ((await res.json().catch(() => null)) as { update?: unknown } | null) : null;
      } catch {
        body = null;
      }
      if (!body?.update) {
        this.set({ state: "error", stage: "rollback", message: `Version ${target} is no longer available from the server. Download an earlier installer from the website.` });
        return { ok: false, error: "The earlier version is not available from the server." };
      }
      const v = verifyManifest(body.update, this.deps.publicKeyPem);
      const file = v.ok ? v.manifest.files.find((f) => f.platform === this.deps.platform && f.arch === this.deps.arch) : undefined;
      if (!v.ok || !file || v.manifest.version !== target || v.manifest.channel !== this.deps.channel()) {
        this.set({ state: "error", stage: "rollback", message: "The earlier version could not be verified, so it was not used." });
        return { ok: false, error: "The earlier version failed verification." };
      }
      const stage = path.join(this.deps.stagingDir, `rollback-${target}`);
      const dl = await downloadAndVerify(
        { ...file, url: new URL(file.url, base).toString() },
        stage,
        async (u) => {
          const res = await doFetch(u, { redirect: "error", signal: AbortSignal.timeout(30 * 60_000) });
          if (!res.ok || !res.body) throw new Error(`The server answered ${res.status} for the download.`);
          return res.body as unknown as AsyncIterable<Uint8Array>;
        },
        { allowLocalNetworkHttp: true }
      );
      if (!dl.ok) {
        this.set({ state: "error", stage: "rollback", message: `The earlier version could not be downloaded safely (${dl.reason}). Nothing was changed.` });
        return { ok: false, error: dl.reason };
      }
      this.state = { ...this.state, badVersions: [...new Set([...this.state.badVersions, this.deps.currentVersion])] };
      this.busy = false;
      return this.runInstaller(dl.path, { version: target, path: dl.path, sha512: file.sha512, size: file.size }, "rollback");
    } finally {
      this.busy = false;
    }
  }

  private async runInstaller(installerPath: string, record: InstallerRecord, kind: "install" | "rollback"): Promise<{ ok: boolean; error?: string }> {
    let backedUp = false;
    try {
      backedUp = (await this.deps.backupBeforeInstall?.()) ?? false;
    } catch {
      backedUp = false;
    }
    this.log(`handing ${record.version} to its installer (${kind}); data backup ${backedUp ? "made" : "not made"}`);
    this.state = markInstalled(this.state, record.version, record, this.deps.currentVersion);
    this.save();
    this.set({ state: "installing", version: record.version });
    try {
      // /S = silent; --updated tells the installer this is an update (it reopens Clynx when it finishes)
      this.deps.launchInstaller(installerPath, ["/S", "--updated"]);
    } catch (err) {
      this.state = { ...this.state, pending: null };
      this.save();
      this.set({ state: "error", stage: kind === "install" ? "install" : "rollback", message: `The installer could not be started (${err instanceof Error ? err.message : err}). Nothing was changed.` });
      return { ok: false, error: "The installer could not be started." };
    }
    setTimeout(() => this.deps.quit(), 600);
    return { ok: true };
  }

  // ---------------------------------------------------------------- schedule
  /** First check shortly after start, then every `everyMs`. Safe to call once. */
  startSchedule(firstDelayMs = 2 * 60_000, everyMs = 6 * 60 * 60_000): void {
    if (this.timer) return;
    const tick = () => {
      this.timer = setTimeout(async () => {
        try {
          await this.check();
        } catch (err) {
          this.log(`scheduled check failed: ${err instanceof Error ? err.message : err}`);
        }
        tick();
      }, everyMs);
      this.timer.unref?.();
    };
    this.timer = setTimeout(async () => {
      try {
        await this.check();
      } catch (err) {
        this.log(`first check failed: ${err instanceof Error ? err.message : err}`);
      }
      tick();
    }, firstDelayMs);
    this.timer.unref?.();
  }
  stopSchedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
