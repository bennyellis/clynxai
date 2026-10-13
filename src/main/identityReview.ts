// The Database review screen's backend (Phase 4). It reads the Database, runs the analysis in identity/reviewFindings.ts, keeps the result in memory, writes an append-only audit
// history, records a person's decision about ONE suggestion at a time, and (only when switched on) applies ONE approved suggestion and undoes it.
// Three independent switches in config.json, all off by default:
//   (none)                       review only: the screen shows findings, evidence, side-by-side and the exact-change preview; every approve / reject / apply attempt is refused and logged.
//   databaseReview.decisions     a person may record approve / reject / undo-decision for one suggestion. Nothing is applied.
//   databaseReview.apply         (needs decisions) an APPROVED suggestion may be applied, one at a time: a Database backup is made first (at most once per few hours), the change and its
//                                before-values are written in one transaction (identity/correctionJournal.ts), and it can be undone exactly. A suggestion that no longer matches what
//                                the Database holds is refused, not forced.
// There is no bulk operation anywhere: every operation takes exactly one suggestion id. Only one-row updates of named columns are possible (see the journal): never a delete, merge,
// rename or insert.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import type { Outcome, PlanItem } from "./identity/correctionJournal.js";
import { analyzeReview, summarizeReview, type CompareRow, type EvidenceLine, type PreviewChange, type ReviewCategory, type ReviewFinding, type ReviewInput, type ReviewProposal } from "./identity/reviewFindings.js";
import { writeFileAtomic } from "./safeFs.js";

export type Decision = "approved" | "rejected";
export interface AppliedInfo {
  batchId: string;
  at: number;
  backup: string | null;
  undoneAt: number | null;
}
export interface DecisionRecord {
  decision: Decision;
  at: number;
  note: string | null;
  // What the suggestion was when it was decided, kept so an applied correction can be shown and undone after the Database changed and the finding is gone.
  snapshot?: { product: string; action: ReviewProposal["action"]; why: string; preview: PreviewChange[] };
  applied?: AppliedInfo;
}
export interface AuditEvent {
  at: number;
  type: "analysis-run" | "decision-recorded" | "decision-cleared" | "decision-blocked" | "correction-applied" | "correction-undone" | "correction-refused";
  detail: Record<string, unknown>;
}
export interface ReviewSnapshot {
  generatedAt: number;
  durationMs: number;
  /** "review-only" while decisions are switched off. */
  mode: "review-only" | "decisions-recorded" | "corrections-enabled";
  decisionsEnabled: boolean;
  applyEnabled: boolean;
  counts: { products: number; findings: number; proposals: number; byCategory: Record<string, { findings: number; confirmed: number; heuristic: number }>; core: number };
  findings: ReviewFinding[];
  proposals: ReviewProposal[];
  decisions: Record<string, DecisionRecord>;
}
export type DecideResult = { ok: true } | { ok: false; reason: string };
export type ApplyResult = { ok: true; backup: string | null } | { ok: false; reason: string };

/** What the review needs from the Database: reads (Store.readReviewInput) and, only for an approved one-suggestion apply, the journaled change, its undo and a backup. */
export interface ReviewSource {
  readReviewInput(): ReviewInput;
  applyCorrection?(batchId: string, item: PlanItem): Outcome;
  undoCorrection?(batchId: string, proposalId: string): Outcome[];
  backupDatabase?(file: string): void;
}
export interface ReviewOptions {
  decisionsEnabled: () => boolean;
  applyEnabled?: () => boolean;
  now?: () => number;
  /** A backup older than this is renewed before applying (default 6 hours). */
  backupMaxAgeMs?: number;
}

export type { CompareRow, EvidenceLine, ReviewCategory, ReviewFinding, ReviewProposal };

const HISTORY_MAX_BYTES = 1024 * 1024;
const ID = /^[0-9a-f]{8,}$/i;

export class IdentityReview {
  private snapshot: ReviewSnapshot | null = null;
  private running: Promise<ReviewSnapshot> | null = null;
  private decisions: Record<string, DecisionRecord> = {};
  private readonly historyFile: string;
  private readonly decisionsFile: string;
  private readonly backupDir: string;
  private readonly now: () => number;
  private readonly decisionsEnabled: () => boolean;
  private readonly applyEnabled: () => boolean;
  private readonly backupMaxAgeMs: number;

  constructor(private source: ReviewSource, private dir: string, opts: ReviewOptions | (() => boolean), legacyNow?: () => number) {
    const o: ReviewOptions = typeof opts === "function" ? { decisionsEnabled: opts, now: legacyNow } : opts;
    this.decisionsEnabled = o.decisionsEnabled;
    this.applyEnabled = o.applyEnabled ?? (() => false);
    this.now = o.now ?? Date.now;
    this.backupMaxAgeMs = o.backupMaxAgeMs ?? 6 * 3600_000;
    this.historyFile = path.join(dir, "review-history.jsonl");
    this.decisionsFile = path.join(dir, "review-decisions.json");
    this.backupDir = path.join(dir, "backups");
    try {
      if (existsSync(this.decisionsFile)) this.decisions = JSON.parse(readFileSync(this.decisionsFile, "utf-8")) as Record<string, DecisionRecord>;
    } catch {
      this.decisions = {};
    }
  }

  private audit(type: AuditEvent["type"], detail: Record<string, unknown>): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      try {
        if (statSync(this.historyFile).size > HISTORY_MAX_BYTES) renameSync(this.historyFile, this.historyFile + ".old");
      } catch {
        /* no file yet */
      }
      appendFileSync(this.historyFile, JSON.stringify({ at: this.now(), type, detail } satisfies AuditEvent) + "\n", "utf-8");
    } catch {
      /* a history that cannot be written never blocks the review (it is shown as missing) */
    }
  }

  /** The most recent audit events, newest first. */
  history(limit = 200): AuditEvent[] {
    try {
      const lines = readFileSync(this.historyFile, "utf-8").trim().split("\n").filter(Boolean);
      return lines
        .slice(-limit)
        .map((l) => JSON.parse(l) as AuditEvent)
        .reverse();
    } catch {
      return [];
    }
  }

  private mode(): ReviewSnapshot["mode"] {
    return this.decisionsEnabled() && this.applyEnabled() ? "corrections-enabled" : this.decisionsEnabled() ? "decisions-recorded" : "review-only";
  }

  get(): ReviewSnapshot | null {
    return this.snapshot ? { ...this.snapshot, mode: this.mode(), decisionsEnabled: this.decisionsEnabled(), applyEnabled: this.decisionsEnabled() && this.applyEnabled(), decisions: { ...this.decisions } } : null;
  }

  /** Runs the analysis (reads only) and keeps the result. Concurrent calls share one run. */
  run(): Promise<ReviewSnapshot> {
    if (this.running) return this.running;
    this.running = (async () => {
      const t0 = this.now();
      const input = this.source.readReviewInput();
      const result = await analyzeReview(input, { yieldNow: () => new Promise<void>((r) => setImmediate(r)) });
      const summary = summarizeReview(result, input.products.length);
      const snap: ReviewSnapshot = {
        generatedAt: this.now(),
        durationMs: this.now() - t0,
        mode: this.mode(),
        decisionsEnabled: this.decisionsEnabled(),
        applyEnabled: this.decisionsEnabled() && this.applyEnabled(),
        counts: { products: input.products.length, findings: result.findings.length, proposals: result.proposals.length, byCategory: summary.findingsByCategory, core: summary.productsFlagged.core },
        findings: result.findings,
        proposals: result.proposals,
        decisions: { ...this.decisions },
      };
      this.snapshot = snap;
      this.audit("analysis-run", { products: input.products.length, findings: result.findings.length, proposals: result.proposals.length, core: summary.productsFlagged.core, durationMs: snap.durationMs, changedAnything: false });
      return snap;
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private validId(proposalId: unknown): proposalId is string {
    return typeof proposalId === "string" && !proposalId.includes(",") && ID.test(proposalId);
  }

  /** Records a person's decision about ONE suggestion. Refused (and logged) unless decisions are switched on; it never changes any Database data. */
  decide(proposalId: string, decision: Decision | "clear", note: string | null = null): DecideResult {
    if (!this.validId(proposalId)) {
      this.audit("decision-blocked", { proposalId: String(proposalId).slice(0, 40), decision, reason: "not a single suggestion id" });
      return { ok: false, reason: "One suggestion at a time." };
    }
    const proposal = this.snapshot?.proposals.find((p) => p.id === proposalId);
    if (!this.decisionsEnabled()) {
      this.audit("decision-blocked", { proposalId, decision, reason: "decisions are switched off (review-only mode)" });
      return { ok: false, reason: "Approving and rejecting are switched off: this screen is review-only until that has been validated." };
    }
    const existing = this.decisions[proposalId];
    if (existing?.applied && !existing.applied.undoneAt) {
      this.audit("decision-blocked", { proposalId, decision, reason: "the correction is applied; undo it first" });
      return { ok: false, reason: "This correction has been applied. Undo it first." };
    }
    if (decision === "clear") {
      delete this.decisions[proposalId];
      this.persist();
      this.audit("decision-cleared", { proposalId, product: proposal?.product ?? existing?.snapshot?.product, action: proposal?.action ?? existing?.snapshot?.action });
      return { ok: true };
    }
    if (!proposal) {
      this.audit("decision-blocked", { proposalId, decision, reason: "no such suggestion in the current review" });
      return { ok: false, reason: "That suggestion is not in the current review. Run the review again." };
    }
    this.decisions[proposalId] = {
      decision, at: this.now(), note: note && note.trim() ? note.trim().slice(0, 500) : null,
      snapshot: { product: proposal.product, action: proposal.action, why: proposal.why, preview: proposal.preview },
    };
    this.persist();
    this.audit("decision-recorded", { proposalId, decision, product: proposal.product, action: proposal.action, preview: proposal.preview, appliedToDatabase: false });
    return { ok: true };
  }

  private newestBackupAge(): number | null {
    try {
      const files = readdirSync(this.backupDir).filter((f) => f.startsWith("before-correction-") && f.endsWith(".db"));
      if (!files.length) return null;
      const newest = Math.max(...files.map((f) => statSync(path.join(this.backupDir, f)).mtimeMs));
      return this.now() - newest;
    } catch {
      return null;
    }
  }

  /** Applies ONE approved suggestion (flag-gated, journaled, backed up, undoable). Refuses anything not approved, stale, or without a data change. */
  apply(proposalId: string): ApplyResult {
    const refuse = (reason: string, why: string): ApplyResult => {
      this.audit("correction-refused", { proposalId: String(proposalId).slice(0, 40), reason: why });
      return { ok: false, reason };
    };
    if (!this.validId(proposalId)) return refuse("One suggestion at a time.", "not a single suggestion id");
    if (!this.decisionsEnabled() || !this.applyEnabled()) return refuse("Applying corrections is switched off.", "apply is switched off (config.databaseReview.apply)");
    if (!this.source.applyCorrection || !this.source.backupDatabase) return refuse("Applying corrections is not available here.", "the Database source cannot apply");
    const rec = this.decisions[proposalId];
    if (!rec || rec.decision !== "approved") return refuse("Only a suggestion you approved can be applied.", "not approved");
    if (rec.applied && !rec.applied.undoneAt) return refuse("This correction is already applied.", "already applied");
    const proposal = this.snapshot?.proposals.find((p) => p.id === proposalId);
    if (!proposal) return refuse("That suggestion is not in the current review. Run the review again.", "not in the current review");
    if (!proposal.change) return refuse("This suggestion changes no stored data, so there is nothing to apply.", "no data change");
    // a recent backup first (the journal undoes this exact change; the backup protects against anything unforeseen)
    let backup: string | null = null;
    const age = this.newestBackupAge();
    if (age === null || age > this.backupMaxAgeMs) {
      try {
        mkdirSync(this.backupDir, { recursive: true });
        backup = path.join(this.backupDir, `before-correction-${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}.db`);
        this.source.backupDatabase(backup);
      } catch (e) {
        return refuse("A backup could not be made, so nothing was changed.", `backup failed: ${(e as Error).message}`);
      }
    }
    const batchId = `review-${this.now()}-${proposalId}`;
    let outcome: Outcome;
    try {
      outcome = this.source.applyCorrection(batchId, { id: proposal.id, change: proposal.change, before: proposal.before });
    } catch (e) {
      return refuse("The correction could not be applied; nothing was changed.", `error: ${(e as Error).message}`);
    }
    if (outcome.status !== "applied") {
      const msg = outcome.status === "skipped-changed-since" ? "The Database has changed since this suggestion was made, so it was not applied. Run the review again." : "The row to change was not found, so nothing was applied.";
      return refuse(msg, outcome.status);
    }
    rec.applied = { batchId, at: this.now(), backup, undoneAt: null };
    this.persist();
    this.audit("correction-applied", { proposalId, batchId, product: proposal.product, action: proposal.action, preview: proposal.preview, backup });
    return { ok: true, backup };
  }

  /** Undoes ONE applied correction exactly. Refused (and logged) when the row was edited again since. */
  undo(proposalId: string): DecideResult {
    if (!this.validId(proposalId)) return { ok: false, reason: "One suggestion at a time." };
    const rec = this.decisions[proposalId];
    if (!this.decisionsEnabled() || !this.applyEnabled()) {
      this.audit("correction-refused", { proposalId, reason: "undo while apply is switched off" });
      return { ok: false, reason: "Applying and undoing corrections is switched off." };
    }
    if (!rec?.applied || rec.applied.undoneAt || !this.source.undoCorrection) return { ok: false, reason: "There is no applied correction to undo." };
    const out = this.source.undoCorrection(rec.applied.batchId, proposalId);
    const status = out[0]?.status;
    if (status !== "undone") {
      this.audit("correction-refused", { proposalId, reason: status ?? "nothing to undo" });
      return { ok: false, reason: status === "undo-refused-changed-since" ? "That row has been edited since the correction, so it was not undone (your edit is kept)." : "Nothing was undone." };
    }
    rec.applied.undoneAt = this.now();
    this.persist();
    this.audit("correction-undone", { proposalId, batchId: rec.applied.batchId, product: rec.snapshot?.product });
    return { ok: true };
  }

  private persist(): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(this.decisionsFile, JSON.stringify(this.decisions, null, 2));
  }
}
