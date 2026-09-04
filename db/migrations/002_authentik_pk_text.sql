-- Authentik 2024+ uses UUID primary keys. Store them as text so inbound
-- snapshot and outbox can round-trip both legacy integer pks and UUIDs.
-- v_group_users must be dropped first; Postgres cannot ALTER a column a view uses.

DROP VIEW IF EXISTS v_group_users;

ALTER TABLE authentik_outbox
  ALTER COLUMN authentik_pk TYPE TEXT USING authentik_pk::text;

ALTER TABLE users
  ALTER COLUMN authentik_pk TYPE TEXT USING authentik_pk::text;

ALTER TABLE groups
  ALTER COLUMN authentik_pk TYPE TEXT USING authentik_pk::text;

ALTER TABLE groups
  ALTER COLUMN parent_pk TYPE TEXT USING parent_pk::text;

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
