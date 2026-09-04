-- Authentik 2024+ uses UUID primary keys. Store them as text so inbound
-- snapshot and outbox can round-trip both legacy integer pks and UUIDs.

ALTER TABLE authentik_outbox
  ALTER COLUMN authentik_pk TYPE TEXT USING authentik_pk::text;

ALTER TABLE users
  ALTER COLUMN authentik_pk TYPE TEXT USING authentik_pk::text;

ALTER TABLE groups
  ALTER COLUMN authentik_pk TYPE TEXT USING authentik_pk::text;

ALTER TABLE groups
  ALTER COLUMN parent_pk TYPE TEXT USING parent_pk::text;
