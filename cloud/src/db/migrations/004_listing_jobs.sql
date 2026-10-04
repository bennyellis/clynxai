-- Clynx Cloud Phase 4 — Cloud processing / AI job queue foundation.
--
-- INFRA ONLY: the worker (src/queue/worker.ts) is a stub that does not call
-- any AI service — see src/queue/worker.ts's header comment. This table
-- tracks job state in Postgres (queryable without hitting Redis directly),
-- mirroring the roadmap's search_jobs/search_job_runs intent, scoped
-- minimally to one row per enqueued listing-processing job for this phase.

CREATE TABLE IF NOT EXISTS listing_processing_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,

  -- 'queued' | 'processing' | 'completed' | 'failed'
  status TEXT NOT NULL DEFAULT 'queued',
  result JSONB,
  error TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_listing_processing_jobs_listing_id ON listing_processing_jobs(listing_id);
CREATE INDEX IF NOT EXISTS idx_listing_processing_jobs_status ON listing_processing_jobs(status);
