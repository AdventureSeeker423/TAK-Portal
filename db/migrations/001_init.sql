-- TAK Portal initial schema. Applied by services/db.js migrate().

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id INT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS json_import_runs (
  file_name TEXT PRIMARY KEY,
  checksum TEXT,
  row_count INT,
  status TEXT NOT NULL DEFAULT 'pending',
  finished_at TIMESTAMPTZ,
  error TEXT
);

CREATE TABLE IF NOT EXISTS json_import_progress (
  id INT PRIMARY KEY DEFAULT 1,
  phase TEXT NOT NULL DEFAULT 'idle',
  started_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  files_total INT DEFAULT 0,
  files_done INT DEFAULT 0,
  current_file TEXT,
  bytes_total BIGINT DEFAULT 0,
  bytes_done BIGINT DEFAULT 0,
  percent INT DEFAULT 0,
  eta_seconds INT,
  message TEXT,
  error TEXT
);
INSERT INTO json_import_progress (id, phase) VALUES (1, 'idle') ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS authentik_outbox (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  authentik_pk INT,
  username TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS authentik_outbox_next_attempt_idx
  ON authentik_outbox (next_attempt_at);
CREATE INDEX IF NOT EXISTS authentik_outbox_entity_idx
  ON authentik_outbox (entity_id);

CREATE TABLE IF NOT EXISTS directory_sync (
  id INT PRIMARY KEY DEFAULT 1,
  last_started_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  completed BOOLEAN NOT NULL DEFAULT false,
  user_count INT DEFAULT 0,
  group_count INT DEFAULT 0
);
INSERT INTO directory_sync (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS dashboard_stats (
  id INT PRIMARY KEY DEFAULT 1,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ
);
INSERT INTO dashboard_stats (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS tak_dashboard_stats (
  id INT PRIMARY KEY DEFAULT 1,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ
);
INSERT INTO tak_dashboard_stats (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS app_update_meta (
  id INT PRIMARY KEY DEFAULT 1,
  latest TEXT,
  update_available BOOLEAN NOT NULL DEFAULT false,
  checked_at TIMESTAMPTZ
);
INSERT INTO app_update_meta (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  authentik_pk INT UNIQUE,
  username TEXT NOT NULL UNIQUE,
  name TEXT,
  email TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  is_superuser BOOLEAN NOT NULL DEFAULT false,
  path TEXT,
  type TEXT,
  sync_status TEXT NOT NULL DEFAULT 'ok',
  pending_delete BOOLEAN NOT NULL DEFAULT false,
  groups_hash TEXT,
  agency TEXT,
  agency_name TEXT,
  agency_abbreviation TEXT,
  agency_color TEXT,
  badge_number TEXT,
  role TEXT,
  radio_callsign TEXT,
  current_template TEXT,
  created_template TEXT,
  created_at_attr TIMESTAMPTZ,
  created_method TEXT,
  created_by_username TEXT,
  created_by_display_name TEXT,
  mutual_aid TEXT,
  mutual_aid_type TEXT,
  mutual_aid_group TEXT,
  integration_type TEXT,
  integration_scope TEXT,
  integration_title TEXT,
  tak_integration_group TEXT,
  state TEXT,
  county TEXT,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_agency_idx ON users (agency);
CREATE INDEX IF NOT EXISTS users_agency_name_idx ON users (agency_name);
CREATE INDEX IF NOT EXISTS users_agency_abbrev_idx ON users (agency_abbreviation);
CREATE INDEX IF NOT EXISTS users_is_active_idx ON users (is_active);
CREATE INDEX IF NOT EXISTS users_pending_delete_idx ON users (pending_delete);
CREATE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));
CREATE INDEX IF NOT EXISTS users_username_trgm_idx ON users USING gin (username gin_trgm_ops);
CREATE INDEX IF NOT EXISTS users_name_trgm_idx ON users USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS users_email_trgm_idx ON users USING gin (email gin_trgm_ops);
CREATE INDEX IF NOT EXISTS users_badge_trgm_idx ON users USING gin (badge_number gin_trgm_ops);

CREATE TABLE IF NOT EXISTS groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  authentik_pk INT UNIQUE,
  name TEXT NOT NULL,
  cn TEXT,
  description TEXT,
  is_private BOOLEAN NOT NULL DEFAULT false,
  is_superuser BOOLEAN NOT NULL DEFAULT false,
  parent_pk INT,
  num_pk INT,
  created_type TEXT,
  created_type_detail TEXT,
  created_at_attr TIMESTAMPTZ,
  created_by_username TEXT,
  created_by_display_name TEXT,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  sync_status TEXT NOT NULL DEFAULT 'ok',
  pending_delete BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS groups_name_idx ON groups (name);
CREATE INDEX IF NOT EXISTS groups_cn_idx ON groups (cn);
CREATE INDEX IF NOT EXISTS groups_created_type_idx ON groups (created_type, created_type_detail);

CREATE TABLE IF NOT EXISTS group_members (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, group_id)
);
CREATE INDEX IF NOT EXISTS group_members_group_idx ON group_members (group_id);

CREATE OR REPLACE VIEW v_group_users AS
SELECT
  g.id AS group_id,
  g.authentik_pk AS group_authentik_pk,
  g.name AS group_name,
  u.id AS user_id,
  u.authentik_pk AS user_authentik_pk,
  u.username,
  u.name AS user_name,
  u.email,
  u.is_active,
  u.agency,
  u.agency_name
FROM group_members gm
JOIN users u ON u.id = gm.user_id
JOIN groups g ON g.id = gm.group_id;

CREATE TABLE IF NOT EXISTS agencies (
  suffix TEXT PRIMARY KEY,
  name TEXT,
  type TEXT,
  county TEXT,
  county_abbrev TEXT,
  state TEXT,
  group_prefix TEXT,
  color TEXT,
  state_federal_agency BOOLEAN DEFAULT false,
  username_token_placement TEXT,
  allowed_admin_group_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  agency_disabled_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  region_id TEXT,
  lookup_domain TEXT,
  lookup_enabled BOOLEAN DEFAULT false,
  admin_groups JSONB,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agency_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  agency_suffix TEXT,
  color_override TEXT,
  role TEXT,
  groups JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_default BOOLEAN NOT NULL DEFAULT false,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS regions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS region_county_locks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL,
  region_id TEXT,
  state TEXT,
  county TEXT,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS permission_overrides (
  username TEXT PRIMARY KEY,
  allow JSONB NOT NULL DEFAULT '[]'::jsonb,
  deny JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS auto_create_groups (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS auto_create_data_sync (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS user_requests (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT,
  created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS mutual_aid (
  id TEXT PRIMARY KEY,
  type TEXT,
  title TEXT,
  group_id TEXT,
  group_name TEXT,
  group_mode TEXT,
  group_was_created BOOLEAN,
  group_master_id TEXT,
  user_id TEXT,
  username TEXT,
  password_enc TEXT,
  expire_enabled BOOLEAN,
  expire_at TIMESTAMPTZ,
  logo_url TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  actor JSONB,
  request JSONB,
  action TEXT,
  target_type TEXT,
  target_id TEXT,
  agency_suffix TEXT,
  agency_name TEXT,
  agency_prefix TEXT,
  details JSONB
);
CREATE INDEX IF NOT EXISTS audit_events_ts_idx ON audit_events (timestamp DESC);

CREATE TABLE IF NOT EXISTS geofences (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS geofence_memberships (
  fence_id TEXT NOT NULL,
  client_uid TEXT NOT NULL,
  inside BOOLEAN NOT NULL DEFAULT false,
  last_enter_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  last_exit_at TIMESTAMPTZ,
  PRIMARY KEY (fence_id, client_uid)
);

CREATE TABLE IF NOT EXISTS channel_patches (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS locators (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS locator_pings (
  id TEXT PRIMARY KEY,
  locator_id TEXT NOT NULL REFERENCES locators(id) ON DELETE CASCADE,
  at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS locator_pings_locator_at_idx ON locator_pings (locator_id, at DESC);

CREATE TABLE IF NOT EXISTS mou_streams (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS mou_user_agreement (
  id INT PRIMARY KEY DEFAULT 1,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);
INSERT INTO mou_user_agreement (id, payload) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS mou_archived (
  archive_id TEXT PRIMARY KEY,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS mou_acks (
  user_key TEXT NOT NULL,
  version_id TEXT NOT NULL,
  at TIMESTAMPTZ,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (user_key, version_id)
);

CREATE TABLE IF NOT EXISTS mou_views (
  key TEXT PRIMARY KEY,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS mou_reminders (
  key TEXT PRIMARY KEY,
  last_sent_at TIMESTAMPTZ,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS mou_sign_invites (
  invite_id TEXT PRIMARY KEY,
  token TEXT UNIQUE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);
