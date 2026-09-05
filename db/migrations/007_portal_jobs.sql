-- Background jobs claimed by the worker (backup export/import, future kinds).

CREATE TABLE IF NOT EXISTS portal_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  progress JSONB NOT NULL DEFAULT '{}'::jsonb,
  options JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB,
  error TEXT,
  artifact_path TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS portal_jobs_status_idx ON portal_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS portal_jobs_kind_idx ON portal_jobs (kind, created_at DESC);
