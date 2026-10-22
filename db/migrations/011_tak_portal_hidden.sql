-- Mirror Authentik attributes.tak_portal_hidden into typed columns for list/count filters.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS tak_portal_hidden BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE groups
  ADD COLUMN IF NOT EXISTS tak_portal_hidden BOOLEAN NOT NULL DEFAULT false;

UPDATE users
SET tak_portal_hidden = true
WHERE pending_delete = false
  AND lower(COALESCE(attributes->>'tak_portal_hidden', '')) IN ('true', '1', 'yes');

UPDATE groups
SET tak_portal_hidden = true
WHERE pending_delete = false
  AND lower(COALESCE(attributes->>'tak_portal_hidden', '')) IN ('true', '1', 'yes');

CREATE INDEX IF NOT EXISTS users_tak_portal_hidden_idx
  ON users (tak_portal_hidden)
  WHERE tak_portal_hidden = true;

CREATE INDEX IF NOT EXISTS groups_tak_portal_hidden_idx
  ON groups (tak_portal_hidden)
  WHERE tak_portal_hidden = true;
