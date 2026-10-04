-- Clynx Cloud Phase 7 — Search Planner foundation. Architecture/data-model
-- only: this snapshot table stores periodic aggregation runs over the
-- `watches` table (already synced by Phase 2) grouping watches by
-- normalized search phrase, so a human (or future acquisition worker) can
-- see cross-user search demand instead of N independent watches. Snapshots
-- are computed on demand (see searchPlanner/service.ts), not live per
-- request or on a timer yet — that wiring is future work.

CREATE TABLE IF NOT EXISTS search_demand_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  computed_at TIMESTAMPTZ NOT NULL,
  phrase_normalized TEXT NOT NULL,
  watch_count INTEGER NOT NULL,
  -- A few contributing watch ids, for visibility/debugging only — not
  -- exhaustive (see aggregate.ts's sampleWatchIds).
  sample_watch_ids JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_search_demand_phrase ON search_demand_snapshots(phrase_normalized);
CREATE INDEX IF NOT EXISTS idx_search_demand_computed_at ON search_demand_snapshots(computed_at);
