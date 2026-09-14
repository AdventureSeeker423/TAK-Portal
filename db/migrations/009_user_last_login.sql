-- Authentik last_login so the Users page can tell "Enabled" vs "Enabled - No Logins"
-- without a live GET for every directory row.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS users_last_login_idx ON users (last_login);
