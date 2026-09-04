-- Copy Authentik custom attributes from JSONB into typed columns used by list/search.

UPDATE groups SET
  cn = COALESCE(NULLIF(btrim(cn), ''), NULLIF(attributes->>'CN', ''), NULLIF(attributes->>'cn', '')),
  description = COALESCE(NULLIF(btrim(description), ''), NULLIF(btrim(attributes->>'description'), '')),
  created_type = COALESCE(NULLIF(btrim(created_type), ''), NULLIF(btrim(attributes->>'created_type'), '')),
  created_type_detail = COALESCE(
    NULLIF(btrim(created_type_detail), ''),
    NULLIF(btrim(attributes->>'created_type_detail'), '')
  ),
  created_by_username = COALESCE(
    NULLIF(btrim(created_by_username), ''),
    NULLIF(btrim(attributes->>'created_by_username'), '')
  ),
  created_by_display_name = COALESCE(
    NULLIF(btrim(created_by_display_name), ''),
    NULLIF(btrim(attributes->>'created_by_display_name'), '')
  ),
  is_private = is_private OR (lower(COALESCE(attributes->>'private', '')) IN ('yes', 'true', '1'))
WHERE pending_delete = false;

UPDATE users SET
  agency = COALESCE(NULLIF(btrim(agency), ''), NULLIF(btrim(attributes->>'agency'), '')),
  agency_name = COALESCE(NULLIF(btrim(agency_name), ''), NULLIF(btrim(attributes->>'agency_name'), '')),
  agency_abbreviation = COALESCE(
    NULLIF(btrim(agency_abbreviation), ''),
    NULLIF(btrim(attributes->>'agency_abbreviation'), ''),
    NULLIF(btrim(attributes->>'agencyAbbreviation'), ''),
    NULLIF(btrim(attributes->>'agencyAbbr'), '')
  ),
  agency_color = COALESCE(NULLIF(btrim(agency_color), ''), NULLIF(btrim(attributes->>'agency_color'), '')),
  badge_number = COALESCE(NULLIF(btrim(badge_number), ''), NULLIF(btrim(attributes->>'badge_number'), '')),
  role = COALESCE(NULLIF(btrim(role), ''), NULLIF(btrim(attributes->>'role'), '')),
  radio_callsign = COALESCE(NULLIF(btrim(radio_callsign), ''), NULLIF(btrim(attributes->>'radio_callsign'), '')),
  current_template = COALESCE(NULLIF(btrim(current_template), ''), NULLIF(btrim(attributes->>'current_template'), '')),
  created_template = COALESCE(NULLIF(btrim(created_template), ''), NULLIF(btrim(attributes->>'created_template'), '')),
  created_method = COALESCE(NULLIF(btrim(created_method), ''), NULLIF(btrim(attributes->>'created_method'), '')),
  created_by_username = COALESCE(
    NULLIF(btrim(created_by_username), ''),
    NULLIF(btrim(attributes->>'created_by_username'), '')
  ),
  created_by_display_name = COALESCE(
    NULLIF(btrim(created_by_display_name), ''),
    NULLIF(btrim(attributes->>'created_by_display_name'), '')
  ),
  mutual_aid = COALESCE(NULLIF(btrim(mutual_aid), ''), NULLIF(btrim(attributes->>'mutual_aid'), '')),
  mutual_aid_type = COALESCE(NULLIF(btrim(mutual_aid_type), ''), NULLIF(btrim(attributes->>'mutual_aid_type'), '')),
  mutual_aid_group = COALESCE(NULLIF(btrim(mutual_aid_group), ''), NULLIF(btrim(attributes->>'mutual_aid_group'), '')),
  integration_type = COALESCE(NULLIF(btrim(integration_type), ''), NULLIF(btrim(attributes->>'integration_type'), '')),
  integration_scope = COALESCE(NULLIF(btrim(integration_scope), ''), NULLIF(btrim(attributes->>'integration_scope'), '')),
  integration_title = COALESCE(NULLIF(btrim(integration_title), ''), NULLIF(btrim(attributes->>'integration_title'), '')),
  tak_integration_group = COALESCE(
    NULLIF(btrim(tak_integration_group), ''),
    NULLIF(btrim(attributes->>'tak_integration_group'), '')
  ),
  state = COALESCE(NULLIF(btrim(state), ''), NULLIF(btrim(attributes->>'state'), '')),
  county = COALESCE(NULLIF(btrim(county), ''), NULLIF(btrim(attributes->>'county'), ''))
WHERE pending_delete = false;

CREATE INDEX IF NOT EXISTS groups_is_private_idx ON groups (is_private) WHERE is_private = true;
