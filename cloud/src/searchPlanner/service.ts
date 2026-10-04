import { query } from "../db/client.js";
import { computeSearchDemand, type SearchDemandGroup } from "./aggregate.js";

// Clynx Cloud Phase 7 — Search Planner foundation. Queries ALL users'
// enabled watches (watches.search_phrase, per migrations/002_watches.sql)
// and stores one aggregation snapshot batch, stamped with a shared
// computed_at so callers can find "the latest run" by filtering to the max
// computed_at. Deliberately NOT enqueued as a BullMQ job or run on a
// timer yet — exposed as a plain function plus a manual-trigger route
// (see routes.ts) for this foundation phase; scheduling is future wiring.

interface WatchPhraseRow {
  id: string;
  search_phrase: string;
}

export async function runSearchDemandAggregation(): Promise<{
  computedAt: string;
  groups: SearchDemandGroup[];
}> {
  const result = await query<WatchPhraseRow>(
    "SELECT id, search_phrase FROM watches WHERE enabled = TRUE"
  );

  const groups = computeSearchDemand(
    result.rows.map((row) => ({ id: row.id, phrase: row.search_phrase }))
  );

  const computedAt = new Date().toISOString();

  for (const group of groups) {
    await query(
      `INSERT INTO search_demand_snapshots (computed_at, phrase_normalized, watch_count, sample_watch_ids)
       VALUES ($1, $2, $3, $4)`,
      [computedAt, group.phraseNormalized, group.watchCount, JSON.stringify(group.sampleWatchIds)]
    );
  }

  return { computedAt, groups };
}

interface SearchDemandSnapshotRow {
  id: string;
  computed_at: string;
  phrase_normalized: string;
  watch_count: number;
  sample_watch_ids: string[];
}

export async function getLatestSearchDemandSnapshot(limit?: number): Promise<SearchDemandSnapshotRow[]> {
  const latest = await query<{ computed_at: string }>(
    "SELECT computed_at FROM search_demand_snapshots ORDER BY computed_at DESC LIMIT 1"
  );
  const computedAt = latest.rows[0]?.computed_at;
  if (!computedAt) {
    return [];
  }

  const result = limit
    ? await query<SearchDemandSnapshotRow>(
        `SELECT * FROM search_demand_snapshots WHERE computed_at = $1 ORDER BY watch_count DESC LIMIT $2`,
        [computedAt, limit]
      )
    : await query<SearchDemandSnapshotRow>(
        `SELECT * FROM search_demand_snapshots WHERE computed_at = $1 ORDER BY watch_count DESC`,
        [computedAt]
      );

  return result.rows;
}
