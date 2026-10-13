// The Database review screen's backend (Phase 4). REVIEW-ONLY: it reads the Database, runs the analysis in identity/reviewFindings.ts, keeps the result in memory, and writes an
// append-only audit history. It has NO code that changes any Database entry, listing, photo, alias or value: there is nothing to "apply" in the app. Recording a person's
// approval or rejection of a suggestion is a separate switch (config.databaseReview.decisions, off by default); while it is off, every attempt is refused and written to the
// history. There is no bulk operation: a decision is about exactly one suggestion.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, renameSync } from "node:fs";
import path from "node:path";
import { analyzeReview, summarizeReview, type CompareRow, type EvidenceLine, type ReviewCategory, type ReviewFinding, type ReviewInput, type ReviewProposal } from "./identity/reviewFindings.js";
import { writeFileAtomic } from "./safeFs.js";

export type Decision = "approved" | "rejected";
export interface DecisionRecord {
  decision: Decision;
  at: number;
  note: string | null;
}
export interface AuditEvent {
  at: number;
  type: "analysis-run" | "decision-recorded" | "decision-cleared" | "decision-blocked";
  detail: Record<string, unknown>;
}
export interface ReviewSnapshot {
  generatedAt: number;
  durationMs: number;
  /** "review-only" while decisions are switched off. */
  mode: "review-only" | "decisions-recorded";
  decisionsEnabled: boolean;
  counts: { products: number; findings: number; proposals: number; byCategory: Record<string, { findings: number; confirmed: number; heuristic: number }>; core: number };
  findings: ReviewFinding[];
  proposals: ReviewProposal[];
  decisions: Record<string, DecisionRecord>;
}
export type DecideResult = { ok: true } | { ok: false; reason: string };

/** What the review needs from the Database, read without writing (implemented by Store.readReviewInput). */
export interface ReviewSource {
  readReviewInput(): ReviewInput;
}

export type { CompareRow, EvidenceLine, ReviewCategory, ReviewFinding, ReviewProposal };

const HISTORY_MAX_BYTES = 1024 * 1024;

export class IdentityReview {
  private snapshot: ReviewSnapshot | null = null;
  private running: Promise<ReviewSnapshot> | null = null;
  private decisions: Record<string, DecisionRecord> = {};
  private readonly historyFile: string;
  private readonly decisionsFile: string;

  constructor(private source: ReviewSource, private dir: string, private decisionsEnabled: () => boolean, private now: () => number = Date.now) {
    this.historyFile = path.join(dir, "review-history.jsonl");
    this.decisionsFile = path.join(dir, "review-decisions.json");
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

  get(): ReviewSnapshot | null {
    return this.snapshot ? { ...this.snapshot, decisionsEnabled: this.decisionsEnabled(), decisions: { ...this.decisions } } : null;
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
        mode: this.decisionsEnabled() ? "decisions-recorded" : "review-only",
        decisionsEnabled: this.decisionsEnabled(),
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

  /** Records a person's decision about ONE suggestion. Refused (and logged) unless decisions are switched on; it never changes any Database data either way. */
  decide(proposalId: string, decision: Decision | "clear", note: string | null = null): DecideResult {
    if (typeof proposalId !== "string" || proposalId.includes(",") || !/^[0-9a-f]{8,}$/i.test(proposalId)) {
      this.audit("decision-blocked", { proposalId: String(proposalId).slice(0, 40), decision, reason: "not a single suggestion id" });
      return { ok: false, reason: "One suggestion at a time." };
    }
    const proposal = this.snapshot?.proposals.find((p) => p.id === proposalId);
    if (!this.decisionsEnabled()) {
      this.audit("decision-blocked", { proposalId, decision, reason: "decisions are switched off (review-only mode)" });
      return { ok: false, reason: "Approving and rejecting are switched off: this screen is review-only until that has been validated." };
    }
    if (!proposal) {
      this.audit("decision-blocked", { proposalId, decision, reason: "no such suggestion in the current review" });
      return { ok: false, reason: "That suggestion is not in the current review. Run the review again." };
    }
    if (decision === "clear") {
      delete this.decisions[proposalId];
      this.persist();
      this.audit("decision-cleared", { proposalId, product: proposal.product, action: proposal.action });
      return { ok: true };
    }
    this.decisions[proposalId] = { decision, at: this.now(), note: note && note.trim() ? note.trim().slice(0, 500) : null };
    this.persist();
    this.audit("decision-recorded", { proposalId, decision, product: proposal.product, action: proposal.action, preview: proposal.preview, appliedToDatabase: false });
    return { ok: true };
  }

  private persist(): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(this.decisionsFile, JSON.stringify(this.decisions, null, 2));
  }
}
