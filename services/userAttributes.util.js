function str(v) {
  return v == null ? "" : String(v);
}

function attrsOf(userOrAttrs) {
  if (!userOrAttrs) return {};
  if (userOrAttrs.attributes && typeof userOrAttrs.attributes === "object") {
    return userOrAttrs.attributes;
  }
  return userOrAttrs;
}

function extractUserColumns(attributes, user = {}) {
  const a = attrsOf(attributes);
  return {
    agency: str(a.agency || user.agency || "").trim() || null,
    agency_name: str(a.agency_name || user.agency_name || "").trim() || null,
    agency_abbreviation:
      str(
        a.agency_abbreviation ||
          a.agencyAbbreviation ||
          a.agencyAbbr ||
          a.agencyabbr ||
          ""
      ).trim() || null,
    agency_color: str(a.agency_color || "").trim() || null,
    badge_number: str(a.badge_number || "").trim() || null,
    role: str(a.role || "").trim() || null,
    radio_callsign: str(a.radio_callsign || "").trim() || null,
    current_template: str(a.current_template || "").trim() || null,
    created_template: str(a.created_template || "").trim() || null,
    created_at_attr: a.created_at || null,
    created_method: str(a.created_method || "").trim() || null,
    created_by_username: str(a.created_by_username || "").trim() || null,
    created_by_display_name: str(a.created_by_display_name || "").trim() || null,
    mutual_aid: str(a.mutual_aid || "").trim() || null,
    mutual_aid_type: str(a.mutual_aid_type || "").trim() || null,
    mutual_aid_group: str(a.mutual_aid_group || "").trim() || null,
    integration_type: str(a.integration_type || "").trim() || null,
    integration_scope: str(a.integration_scope || "").trim() || null,
    integration_title: str(a.integration_title || "").trim() || null,
    tak_integration_group: str(a.tak_integration_group || "").trim() || null,
    state: str(a.state || "").trim() || null,
    county: str(a.county || "").trim() || null,
  };
}

function extractGroupColumns(attributes) {
  const a = attrsOf(attributes);
  const privateRaw = str(a.private || "").trim().toLowerCase();
  return {
    created_type: str(a.created_type || "").trim() || null,
    created_type_detail: str(a.created_type_detail || "").trim() || null,
    created_at_attr: a.created_at || null,
    created_by_username: str(a.created_by_username || "").trim() || null,
    created_by_display_name: str(a.created_by_display_name || "").trim() || null,
    cn: str(a.CN || a.cn || "").trim() || null,
    description: str(a.description || "").trim() || null,
    is_private: privateRaw === "yes" || privateRaw === "true" || privateRaw === "1",
  };
}

function membershipHash(pks) {
  const list = (Array.isArray(pks) ? pks : [])
    .map((x) => String(x).trim())
    .filter(Boolean)
    .sort();
  return list.join(",");
}

module.exports = {
  extractUserColumns,
  extractGroupColumns,
  membershipHash,
};
