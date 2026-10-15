// Every listing a pass found is accounted for. A location's "found 18 listings" used to be followed by "9 evaluated" with the other nine nowhere:
// listings already seen before were dropped silently, the ones the relevance filter left out were never mentioned, and the ones the per-location limit
// cut off were simply never reached. This keeps one tally per pass (a browse of the feed, or a search for one Search For item) that always adds up.

export type ListingOutcome = "opened" | "skipped_before_opening" | "already_seen" | "no_price" | "load_failed" | "other";

export class PassAccount {
  private readonly counts: Record<ListingOutcome, number> = { opened: 0, skipped_before_opening: 0, already_seen: 0, no_price: 0, load_failed: 0, other: 0 };
  private filteredOut = 0;
  private leftOver = 0;
  private interrupted = false;
  private candidates = 0;

  constructor(
    readonly label: string,
    readonly found: number
  ) {}

  /** Listings the relevance filter left out before any of them was looked at. */
  setCandidates(candidates: number): void {
    this.candidates = candidates;
    this.filteredOut = Math.max(0, this.found - candidates);
  }

  record(outcome: ListingOutcome): void {
    this.counts[outcome]++;
  }

  /** Called once the loop is over: whatever was not looked at is "left for later" (a per-location limit or a search rotation) or "interrupted" (stop / priority search). */
  settle(interrupted: boolean): void {
    const handled = Object.values(this.counts).reduce((a, b) => a + b, 0);
    this.leftOver = Math.max(0, this.candidates - handled);
    this.interrupted = interrupted && this.leftOver > 0;
  }

  /** Everything found is in exactly one bucket. */
  get accounted(): number {
    return Object.values(this.counts).reduce((a, b) => a + b, 0) + this.filteredOut + this.leftOver;
  }

  get balanced(): boolean {
    return this.accounted === this.found;
  }

  get opened(): number {
    return this.counts.opened;
  }

  describe(): string {
    const parts: string[] = [];
    const add = (n: number, text: string) => n > 0 && parts.push(`${n} ${text}`);
    add(this.counts.opened, "opened and judged");
    add(this.counts.skipped_before_opening, "skipped before opening (a filter said no)");
    add(this.counts.already_seen, "already seen on an earlier pass");
    add(this.counts.no_price, "had no price");
    add(this.counts.load_failed, "failed to open");
    add(this.counts.other, "dropped for another reason");
    add(this.filteredOut, "not relevant to your Search For list");
    add(this.leftOver, this.interrupted ? "left unvisited (the scan was stopped or interrupted)" : "left for the next pass (per-location limit or search rotation)");
    return `${this.label}: of ${this.found} found, ${parts.length ? parts.join(", ") : "nothing to account for"}${this.balanced ? "" : ` (${this.found - this.accounted} unaccounted)`}.`;
  }
}
