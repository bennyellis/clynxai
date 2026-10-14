// Automatic desktop updates: check the signed-in server for a newer SIGNED build, download it in the background, and install it and restart by itself (mode "automatic", the default) or
// when the person says so (modes "download" and "notify").
//
// What is trusted, and what is not:
//   * The server is NOT trusted. It hands over a manifest signed with the update key; this app holds only the PUBLIC half (resources/update-public.pem) and refuses anything whose
//     signature does not verify, that is for another channel/platform, that is not newer than the running version, or whose publish time is older than one already accepted.
//   * The downloaded installer is NOT trusted either: it is used only if its size, SHA-512 and SHA-256 equal what the signed manifest states, and is hashed again right before it runs.
//   * In mode "automatic" a verified update installs by itself, but only when Clynx is idle (no scan, Watch check or research running; after at most MAX_BUSY_WAIT it installs anyway), never in
//     the first minutes after start, never while the version now running is still unproven (a just-installed update), and never again for a version whose last install did not finish.
//   * The Owner can mark a release REQUIRED (with a deadline). The server only tells the app WHEN; the app still verifies the release itself. While online, such an update installs by the
//     deadline whatever the person chose (even "off"): it waits for an idle moment until then, and after the deadline waits only a short while more (OVERDUE_BUSY_GRACE).
//   * Just before it installs, the app asks the server once more whether that release is still the one on offer: a release withdrawn after it was downloaded is dropped, not installed.
//     In the other modes nothing installs without the person's click ("Restart and install"). User data (Database, settings, Facebook profile, keys) lives outside the install folder and is never touched
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

export type UpdateMode = "off" | "notify" | "download" | "automatic";
export type AutoPhase = "waiting-busy" | "waiting-start" | "waiting-unproven" | "waiting-server" | "skipped-failed-before" | "overdue-waiting" | null;

/** How often a ready update is reconsidered for automatic installation, how long after start Clynx waits before it may restart itself, and how long a busy scanner can postpone it. */
export const AUTO_INSTALL_CHECK_MS = 60_000;
export const AUTO_INSTALL_START_GRACE_MS = 90_000;
export const MAX_BUSY_WAIT_MS = 12 * 60 * 60_000;
/** After a REQUIRED update's deadline a running scan gets this much longer to finish; then the update goes ahead (scans stop safely and are restarted afterwards). */
export const OVERDUE_BUSY_GRACE_MS = 10 * 60_000;
/** A REQUIRED update whose installer failed once is tried again after this long (an ordinary update is not retried by itself). */
export const REQUIRED_RETRY_AFTER_FAILURE_MS = 6 * 60 * 60_000;
/** When a check or download fails the next try comes sooner than the normal interval: 5 minutes, then 15, then 30. */
export const RETRY_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000];
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
  /** The Owner has marked an update as REQUIRED for this computer (it is behind that version). `overdue` = the deadline has passed. */
  required: { version: string; deadline: string; overdue: boolean } | null;
  /** Why a downloaded update is waiting (automatic mode), or null. */
  autoInstall: { phase: AutoPhase; waitingSince: number | null } | null;
  /** When the next automatic check will happen, and how many checks or downloads in a row have failed. */
  nextCheckAt: number | null;
  consecutiveFailures: number;
}

export interface UpdaterDeps {
  /** The signed-in server's address, or null when there is no server (local mode, signed out): then nothing is checked. */
  getServerBase: () => string | null;
  /** The Authorization header for the signed-in server (a private server refuses update checks and installer downloads without it). Sent ONLY to that server, never to another address. */
  authHeader?: () => string | null;
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
  /** True while a scan or a Watch check is running: an automatic install waits for it to finish (up to MAX_BUSY_WAIT). */
  isBusy?: () => boolean;
  /** Gets a new access token after the server answered 401 to an update request (so a token that just expired does not make a check fail). Returns whether there is a fresh one. */
  refreshAuth?: () => Promise<boolean>;
  /** Called just before the installer is started, so the app can remember what must be resumed afterwards (a running scanner). */
  beforeInstall?: () => void;
  /** Starts the installer and returns; the app is quit by `quit` right after. */
  launchInstaller: (installerPath: string, args: string[]) => void;
  quit: () => void;
  onStatus?: (s: UpdateStatus) => void;
  /** Called when something needs the person's attention (a failed update, a version that will not start). */
  onProblem?: (p: { kind: "installer-did-not-finish" | "rollback-offered"; version: string; message: string; canRollback: boolean }) => void;
  log?: (msg: string) => void;
  now?: () => number;
  /** A clock that only moves forward and ignores the person changing the computer's clock (default: performance.now). Used to measure time since the server last told us its time. */
  monotonic?: () => number;
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
  private autoTimer: ReturnType<typeof setInterval> | null = null;
  private readySince: number | null = null;
  private autoPhase: AutoPhase = null;
  private failures = 0;
  private nextCheckAt: number | null = null;
  private anchor: { serverMs: number; monoMs: number } | null = null;
  private readonly startedAt: number;
  private readonly now: () => number;

  constructor(private deps: UpdaterDeps) {
    this.now = deps.now ?? Date.now;
    this.startedAt = this.now();
    this.state = readUpdateState(deps.stateFile);
  }

  private save(): void {
    try {
      writeUpdateState(this.deps.stateFile, this.state);
    } catch (err) {
      this.deps.log?.(`[updates] could not save update state: ${err instanceof Error ? err.message : err}`);
    }
  }
  /** The sign-in header, but only for requests to the server we are signed in to: an update file hosted elsewhere never receives it. */
  private authFor(url: string, base: string): Record<string, string> {
    const h = this.deps.authHeader?.();
    if (!h) return {};
    try {
      return new URL(url).origin === new URL(base).origin ? { Authorization: h } : {};
    } catch {
      return {};
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
      required: this.requiredActive() ? { version: this.state.required!.version, deadline: this.state.required!.deadline, overdue: this.overdueMs() > 0 } : null,
      autoInstall: this.status.state === "ready" ? { phase: this.autoPhase, waitingSince: this.readySince } : null,
      nextCheckAt: this.nextCheckAt,
      consecutiveFailures: this.failures,
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

  // ---------------------------------------------------------------- required updates
  /** The server's clock (best estimate): this computer's clock corrected by the difference measured at the last successful check, so setting the local clock back does not delay a deadline. */
  private serverNow(): number {
    // measured since the server last told us its time with a clock that cannot be set back; before the first check of this run, the offset saved from the last run is applied to the local clock
    if (this.anchor) return this.anchor.serverMs + ((this.deps.monotonic ?? (() => performance.now()))() - this.anchor.monoMs);
    return this.now() + (this.state.required?.offsetMs ?? 0);
  }
  /** True while the Owner's "required" mark applies to this computer (it is behind the required version). */
  private requiredActive(): boolean {
    const r = this.state.required;
    return !!r && compareVersions(r.version, this.deps.currentVersion) > 0 && !this.state.badVersions.includes(r.version);
  }
  /** Milliseconds past the required deadline (0 or negative while the deadline is still ahead). */
  private overdueMs(): number {
    const r = this.state.required;
    return r && this.requiredActive() ? this.serverNow() - Date.parse(r.deadline) : -1;
  }
  /** The mode that really applies: a required update behaves like "automatic" whatever the person chose. */
  private effectiveMode(): UpdateMode {
    return this.requiredActive() ? "automatic" : this.deps.mode();
  }
  private noteRequired(raw: unknown, serverTime: unknown): void {
    const r = raw as { version?: unknown; deadline?: unknown } | null | undefined;
    const st = typeof serverTime === "string" ? Date.parse(serverTime) : NaN;
    const offset = Number.isNaN(st) ? (this.state.required?.offsetMs ?? 0) : st - this.now();
    if (!Number.isNaN(st)) this.anchor = { serverMs: st, monoMs: (this.deps.monotonic ?? (() => performance.now()))() };
    if (r && typeof r.version === "string" && typeof r.deadline === "string" && !Number.isNaN(Date.parse(r.deadline)) && compareVersions(r.version, this.deps.currentVersion) > 0) {
      this.state = { ...this.state, required: { version: r.version, deadline: r.deadline, offsetMs: offset } };
    } else if (this.state.required) {
      this.state = { ...this.state, required: null };
    }
    this.save();
  }

  // ---------------------------------------------------------------- checking
  /** One request for the newest signed manifest. A 401 triggers one token refresh and a second try. */
  private async fetchLatest(base: string): Promise<{ ok: true; res: Response } | { ok: false; unreachable: boolean }> {
    const channel = this.deps.channel();
    const doFetch = this.deps.fetchImpl ?? fetch;
    const url = `${base.replace(/\/+$/, "")}/updates/${channel}/latest?platform=${encodeURIComponent(this.deps.platform)}&arch=${encodeURIComponent(this.deps.arch)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, { signal: AbortSignal.timeout(15_000), redirect: "error", headers: { Accept: "application/json", ...this.authFor(url, base) } });
      } catch {
        return { ok: false, unreachable: true };
      }
      if (res.status === 401 && attempt === 0 && this.deps.refreshAuth && (await this.deps.refreshAuth().catch(() => false))) continue;
      return { ok: true, res };
    }
    return { ok: false, unreachable: true };
  }

  private fail(stage: "check" | "signature" | "download", message: string): UpdateStatus {
    this.failures++;
    this.set({ state: "error", stage, message });
    return this.status;
  }

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
    // (mode "off" still asks the server, quietly, because an update the Owner has REQUIRED must be heard about; unless required, nothing is announced or downloaded in that mode)
    this.busy = true;
    this.set({ state: "checking" });
    try {
      const channel = this.deps.channel();
      const got = await this.fetchLatest(base);
      if (!got.ok) return this.fail("check", "Could not reach the server to check for updates. It will try again soon.");
      const res = got.res;
      if (res.status === 404) {
        this.lastCheckedAt = this.now();
        this.failures = 0;
        this.set({ state: "up-to-date", checkedAt: this.lastCheckedAt }); // an older server without update support
        return this.status;
      }
      if (res.status === 401) return this.fail("check", "The server did not accept this sign-in for the update check. Sign out and in again; it will try again soon.");
      if (!res.ok) return this.fail("check", `The server could not check for updates (error ${res.status}).`);
      const body = (await res.json().catch(() => null)) as { update?: unknown; required?: unknown; serverTime?: unknown } | null;
      this.lastCheckedAt = this.now();
      this.failures = 0;
      this.noteRequired(body?.required, body?.serverTime);
      if (!body || body.update === null || body.update === undefined) {
        this.set({ state: "up-to-date", checkedAt: this.lastCheckedAt });
        return this.status;
      }
      const verified = verifyManifest(body.update, this.deps.publicKeyPem);
      if (!verified.ok) {
        this.log(`REJECTED an update from the server: ${verified.reason}`);
        return this.fail("signature", `An update was offered, but it could not be verified (${verified.reason}) so it was ignored.`);
      }
      const m = verified.manifest;
      const offer = evaluateOffer(m, { currentVersion: this.deps.currentVersion, channel, platform: this.deps.platform, arch: this.deps.arch, state: this.state });
      if (!offer.offer || !offer.file) {
        this.set({ state: "up-to-date", checkedAt: this.lastCheckedAt });
        return this.status;
      }
      if (this.deps.mode() === "off" && !opts.manual && !this.requiredActive()) {
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
        this.armAutoInstall();
        return this.status;
      }
      this.set({ state: "available", version: m.version, notes: m.notes ?? "", size: offer.file.size, publishedAt: m.publishedAt });
    } finally {
      this.busy = false;
    }
    const em = this.effectiveMode();
    if (em === "download" || em === "automatic") await this.download();
    return this.status;
  }

  /** Just before installing: is this still the release the server offers? A release withdrawn (or replaced) after it was downloaded must not be installed. */
  private async confirmStillOffered(): Promise<"yes" | "gone" | "unreachable"> {
    const o = this.offered;
    const base = this.deps.getServerBase();
    if (!o || !base || !this.deps.publicKeyPem) return "unreachable";
    const got = await this.fetchLatest(base);
    if (!got.ok || !got.res.ok) return "unreachable";
    const body = (await got.res.json().catch(() => null)) as { update?: unknown; required?: unknown; serverTime?: unknown } | null;
    if (!body) return "unreachable";
    this.noteRequired(body.required, body.serverTime);
    if (body.update === null || body.update === undefined) return "gone";
    const v = verifyManifest(body.update, this.deps.publicKeyPem);
    if (!v.ok) return "gone";
    return v.manifest.version === o.manifest.version ? "yes" : "gone";
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
        async (u, range) => {
          const headers: Record<string, string> = { ...this.authFor(u, base) };
          if (range) headers.Range = `bytes=${range.start}-`;
          let res = await doFetch(u, { redirect: "error", signal: AbortSignal.timeout(30 * 60_000), headers });
          if (range && res.status === 416) {
            // what is kept does not fit the file on the server: ask for the whole file
            delete headers.Range;
            res = await doFetch(u, { redirect: "error", signal: AbortSignal.timeout(30 * 60_000), headers });
          }
          if (!res.ok || !res.body) throw new Error(`The server answered ${res.status} for the download.`);
          return { body: res.body as unknown as AsyncIterable<Uint8Array>, resumed: res.status === 206 && !!headers.Range };
        },
        {
          allowLocalNetworkHttp: true,
          resume: true,
          onProgress: (received, total) => {
            if (received === total || received % (4 * 1024 * 1024) < 65536) this.set({ state: "downloading", version: o.manifest.version, received, total });
          },
        }
      );
      if (!result.ok) {
        this.log(`download failed: ${result.reason}`);
        this.failures++;
        this.set({ state: "error", stage: "download", message: `The update could not be downloaded safely (${result.reason}). Nothing was installed.${result.resumable ? " What was received is kept, and the download continues from there." : ""}` });
        return this.status;
      }
      this.failures = 0;
      this.readyPath = result.path;
      this.set({ state: "ready", version: o.manifest.version, notes: o.manifest.notes ?? "" });
      this.armAutoInstall();
      return this.status;
    } finally {
      this.busy = false;
    }
  }

  // ---------------------------------------------------------------- automatic installation
  /** Starts watching a ready update (mode "automatic" only). Safe to call repeatedly. */
  private armAutoInstall(): void {
    if (this.effectiveMode() !== "automatic") return;
    this.readySince ??= this.now();
    if (this.autoTimer) return;
    this.autoTimer = setInterval(() => void this.autoInstallTick(), AUTO_INSTALL_CHECK_MS);
    this.autoTimer.unref?.();
  }
  private disarmAutoInstall(): void {
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.autoTimer = null;
    this.readySince = null;
    this.autoPhase = null;
  }

  /** One look at whether the ready update may be installed now. Public so it can be tested with a fake clock. Returns what it decided. */
  async autoInstallTick(): Promise<"installed" | "waiting-busy" | "waiting-start" | "waiting-unproven" | "waiting-server" | "skipped" | "none"> {
    if (this.effectiveMode() !== "automatic" || this.status.state !== "ready" || !this.offered) {
      this.autoPhase = null;
      if (this.status.state !== "ready") this.disarmAutoInstall();
      return "none";
    }
    const version = this.offered.manifest.version;
    const required = this.requiredActive();
    // a version whose installer already failed to finish once is not retried by itself (the person can still click); a REQUIRED one is tried again after a few hours
    const f = this.state.lastFailure;
    if (f && f.version === version && !(required && this.now() - Date.parse(f.at) > REQUIRED_RETRY_AFTER_FAILURE_MS)) {
      this.autoPhase = "skipped-failed-before";
      return "skipped";
    }
    // the version now running must have proven it starts, or a bad update could restart the app in a loop
    if (this.state.pending) {
      this.autoPhase = "waiting-unproven";
      return "waiting-unproven";
    }
    if (this.now() - this.startedAt < AUTO_INSTALL_START_GRACE_MS) {
      this.autoPhase = "waiting-start";
      return "waiting-start";
    }
    const waited = this.now() - (this.readySince ?? this.now());
    const overdue = this.overdueMs();
    const mustGoNow = required && overdue >= OVERDUE_BUSY_GRACE_MS;
    if (this.deps.isBusy?.() && !mustGoNow && waited < MAX_BUSY_WAIT_MS) {
      this.autoPhase = required && overdue > 0 ? "overdue-waiting" : "waiting-busy";
      return "waiting-busy";
    }
    // one last question to the server: is this still the release on offer (not withdrawn, not replaced)?
    const still = await this.confirmStillOffered();
    if (still === "gone") {
      this.log(`${version} is no longer offered by the server (withdrawn or replaced): it will not be installed`);
      this.offered = null;
      this.readyPath = null;
      this.autoPhase = null;
      this.disarmAutoInstall();
      this.set({ state: "up-to-date", checkedAt: this.now() });
      void this.check().catch(() => undefined); // a newer release may be waiting
      return "skipped";
    }
    if (still === "unreachable") {
      this.autoPhase = "waiting-server";
      return "waiting-server";
    }
    this.log(`installing ${version} automatically${this.deps.isBusy?.() ? " (waited the longest it may for a scan to finish)" : ""}${required ? " [required update]" : ""}`);
    this.autoPhase = null;
    this.disarmAutoInstall();
    const r = await this.installNow({ confirmed: true });
    return r.ok ? "installed" : "skipped";
  }

  // ---------------------------------------------------------------- installing (on the person's click, or by itself in mode "automatic")
  async installNow(opts: { confirmed?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
    const o = this.offered;
    if (this.status.state !== "ready" || !o || !this.readyPath) return { ok: false, error: "There is no downloaded update to install." };
    if (!fs.existsSync(this.readyPath) || hashFile(this.readyPath, "sha512") !== o.file.sha512 || (o.file.sha256 && hashFile(this.readyPath, "sha256") !== o.file.sha256)) {
      this.readyPath = null;
      this.set({ state: "error", stage: "install", message: "The downloaded update no longer matches its signed checksum, so it was not installed. Check for updates again." });
      return { ok: false, error: "The downloaded file failed its final check." };
    }
    if (!opts.confirmed && (await this.confirmStillOffered()) === "gone") {
      this.offered = null;
      this.readyPath = null;
      this.disarmAutoInstall();
      this.set({ state: "up-to-date", checkedAt: this.now() });
      return { ok: false, error: "The server no longer offers this update (it was withdrawn or replaced), so it was not installed." };
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
        const res = await doFetch(url, { signal: AbortSignal.timeout(15_000), redirect: "error", headers: this.authFor(url, base) });
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
          const res = await doFetch(u, { redirect: "error", signal: AbortSignal.timeout(30 * 60_000), headers: this.authFor(u, base) });
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
    try {
      this.deps.beforeInstall?.();
    } catch {
      /* remembering what to resume is best effort */
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
  /** First check shortly after start, then every `everyMs` (sooner after a failure: see RETRY_BACKOFF_MS). Safe to call once. */
  startSchedule(firstDelayMs = 2 * 60_000, everyMs = 60 * 60_000): void {
    if (this.timer) return;
    const schedule = (delay: number) => {
      this.nextCheckAt = this.now() + delay;
      this.timer = setTimeout(async () => {
        try {
          await this.check();
        } catch (err) {
          this.failures++;
          this.log(`scheduled check failed: ${err instanceof Error ? err.message : err}`);
        }
        const failing = this.status.state === "error" && this.status.stage !== "signature";
        schedule(failing ? Math.min(everyMs, RETRY_BACKOFF_MS[Math.min(Math.max(this.failures, 1), RETRY_BACKOFF_MS.length) - 1]) : everyMs);
      }, delay);
      this.timer.unref?.();
    };
    schedule(firstDelayMs);
  }
  stopSchedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.disarmAutoInstall();
  }
}
