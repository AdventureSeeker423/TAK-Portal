-- Cache Authentik enrollment app-passwords so Users / Setup My Device QR
-- generation can skip repeated /core/tokens list+view_key round-trips.

CREATE TABLE IF NOT EXISTS enrollment_app_passwords (
  authentik_user_pk TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  key_enc TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS enrollment_app_passwords_expires_idx
  ON enrollment_app_passwords (expires_at);
