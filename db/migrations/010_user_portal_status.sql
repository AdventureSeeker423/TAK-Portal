-- Persist Users-page portal role / status so list/search/sort do not recompute
-- from group memberships, TAK certs, or Authentik on every request.

ALTER TABLE directory_sync
  ADD COLUMN IF NOT EXISTS tak_certs_known BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tak_certs_checked_at TIMESTAMPTZ;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS portal_role TEXT NOT NULL DEFAULT 'User',
  ADD COLUMN IF NOT EXISTS has_active_tak_cert BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS status_label TEXT,
  ADD COLUMN IF NOT EXISTS status_sort_rank SMALLINT;

UPDATE users
SET
  status_label = CASE
    WHEN COALESCE(is_active, false) = false THEN 'Disabled'
    ELSE COALESCE(NULLIF(btrim(portal_role), ''), 'User')
  END,
  status_sort_rank = CASE
    WHEN COALESCE(is_active, false) = false THEN 0
    ELSE 2
  END
WHERE status_label IS NULL OR status_sort_rank IS NULL;

ALTER TABLE users
  ALTER COLUMN status_label SET DEFAULT 'User',
  ALTER COLUMN status_label SET NOT NULL,
  ALTER COLUMN status_sort_rank SET DEFAULT 2,
  ALTER COLUMN status_sort_rank SET NOT NULL;

CREATE INDEX IF NOT EXISTS users_status_sort_idx ON users (status_sort_rank, username);
CREATE INDEX IF NOT EXISTS users_status_label_idx ON users (status_label);
CREATE INDEX IF NOT EXISTS users_status_label_trgm_idx ON users USING gin (status_label gin_trgm_ops);
