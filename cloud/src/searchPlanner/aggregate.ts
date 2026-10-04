// Clynx Cloud Phase 7 — Search Planner foundation. Pure aggregation logic,
// deliberately kept free of DB access so it's trivially unit-testable.
// Normalization here is intentionally simple (lowercase, trim, collapse
// whitespace) — not fuzzy matching/NLP, that's future work.

export interface SearchDemandInput {
  id: string;
  phrase: string;
}

export interface SearchDemandGroup {
  phraseNormalized: string;
  watchCount: number;
  sampleWatchIds: string[];
}

// Cap on how many contributing watch ids are retained per group — this is
// for visibility/debugging only, not meant to be exhaustive.
const MAX_SAMPLE_WATCH_IDS = 5;

export function normalizeSearchPhrase(phrase: string): string {
  return phrase.trim().toLowerCase().replace(/\s+/g, " ");
}

export function computeSearchDemand(watches: SearchDemandInput[]): SearchDemandGroup[] {
  const groups = new Map<string, { watchCount: number; sampleWatchIds: string[] }>();

  for (const watch of watches) {
    const phraseNormalized = normalizeSearchPhrase(watch.phrase);
    if (!phraseNormalized) continue;

    const existing = groups.get(phraseNormalized);
    if (existing) {
      existing.watchCount += 1;
      if (existing.sampleWatchIds.length < MAX_SAMPLE_WATCH_IDS) {
        existing.sampleWatchIds.push(watch.id);
      }
    } else {
      groups.set(phraseNormalized, { watchCount: 1, sampleWatchIds: [watch.id] });
    }
  }

  return Array.from(groups.entries())
    .map(([phraseNormalized, { watchCount, sampleWatchIds }]) => ({
      phraseNormalized,
      watchCount,
      sampleWatchIds,
    }))
    .sort((a, b) => b.watchCount - a.watchCount);
}
