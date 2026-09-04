CREATE INDEX IF NOT EXISTS users_current_template_idx ON users (current_template);
CREATE INDEX IF NOT EXISTS users_agency_lower_idx ON users (lower(agency));
