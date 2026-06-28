const agenciesSvc = require("./agencies.service");
const groupsSvc = require("./groups.service");
const usersSvc = require("./users.service");

function safeStr(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function normalizeSuffix(value) {
  return safeStr(value).trim().toLowerCase();
}

function normalizeIdList(raw) {
  if (Array.isArray(raw)) return raw.map((v) => safeStr(v).trim()).filter(Boolean);
  const one = safeStr(raw).trim();
  return one ? [one] : [];
}

function capList(items, max = 250) {
  const list = (Array.isArray(items) ? items : []).map(safeStr).filter(Boolean);
  if (list.length <= max) {
    return { items: list, truncated: false, total: list.length, omitted: 0 };
  }
  return {
    items: list.slice(0, max),
    truncated: true,
    total: list.length,
    omitted: list.length - max,
  };
}

function agencyLabelsFromSuffixes(suffixes) {
  const agencies = agenciesSvc.load();
  const bySuffix = new Map(
    agencies.map((a) => [normalizeSuffix(a && a.suffix), a]).filter(([sfx]) => sfx)
  );
  return normalizeIdList(suffixes).map((sfx) => {
    const agency = bySuffix.get(normalizeSuffix(sfx));
    if (!agency) return sfx;
    const name = safeStr(agency.name).trim();
    return name ? `${name} (${sfx})` : sfx;
  });
}

async function resolveGroupNames(ids) {
  const unique = [...new Set(normalizeIdList(ids))];
  return Promise.all(
    unique.map(async (id) => {
      try {
        const g = await groupsSvc.getGroupById(id);
        return safeStr(g?.name).trim() || id;
      } catch (_) {
        return id;
      }
    })
  );
}

async function resolveUsernames(ids) {
  const unique = [...new Set(normalizeIdList(ids))];
  return Promise.all(
    unique.map(async (id) => {
      try {
        const u = await usersSvc.getUserById(id);
        return safeStr(u?.username).trim() || id;
      } catch (_) {
        return id;
      }
    })
  );
}

function diffStringLists(before, after) {
  const beforeSet = new Set((before || []).map(safeStr).filter(Boolean));
  const afterSet = new Set((after || []).map(safeStr).filter(Boolean));
  return {
    added: [...afterSet].filter((x) => !beforeSet.has(x)),
    removed: [...beforeSet].filter((x) => !afterSet.has(x)),
  };
}

function templateTargetId(name, agencySuffix) {
  const n = safeStr(name).trim();
  const sfx = normalizeSuffix(agencySuffix);
  if (n && sfx) return `${n} (${sfx})`;
  return n || sfx || "template";
}

function inferMassAssignSourceMode(payload = {}) {
  if (
    payload.sourceMode === "group" ||
    payload.sourceMode === "users" ||
    payload.sourceMode === "agency"
  ) {
    return payload.sourceMode;
  }
  if (Array.isArray(payload.userIds) && payload.userIds.length) return "users";
  const sourceGroupIds = payload.sourceGroupIds ?? payload.sourceGroupId;
  if (Array.isArray(sourceGroupIds) && sourceGroupIds.length) return "group";
  if (sourceGroupIds) return "group";
  return "agency";
}

function buildTemplateCreateDetails(template) {
  const name = safeStr(template?.name).trim();
  const agencySuffix = normalizeSuffix(template?.agencySuffix);
  const groups = Array.isArray(template?.groups)
    ? template.groups.map(safeStr).filter(Boolean)
    : [];
  return {
    summary: `Created template "${name}"${agencySuffix ? ` (${agencySuffix})` : ""} with groups: ${groups.join(", ") || "(none)"}.`,
    name,
    agencySuffix: agencySuffix || undefined,
    isDefault: !!template?.isDefault,
    groups,
    groupsCount: groups.length,
    colorOverride: template?.colorOverride || "",
    role: template?.role || "Team Member",
  };
}

function buildTemplateUpdateDetails({
  existing,
  updated,
  beforeGroups,
  afterGroups,
  currentTemplateSync,
  templateIndex,
}) {
  const { added, removed } = diffStringLists(beforeGroups, afterGroups);
  const name = safeStr(updated?.name || existing?.name).trim();
  const agencySuffix = normalizeSuffix(updated?.agencySuffix || existing?.agencySuffix);
  const beforeName = safeStr(existing?.name).trim();
  const nameChanged = beforeName && name && beforeName !== name;

  const parts = [];
  if (nameChanged) parts.push(`renamed from "${beforeName}" to "${name}"`);
  if (added.length) parts.push(`added groups: ${added.join(", ")}`);
  if (removed.length) parts.push(`removed groups: ${removed.join(", ")}`);

  const userUpdated = Number(currentTemplateSync?.updated || 0);
  if (userUpdated > 0) parts.push(`${userUpdated} user(s) synced`);

  const summary = parts.length
    ? `Updated template "${name}"${agencySuffix ? ` (${agencySuffix})` : ""}: ${parts.join("; ")}.`
    : `Updated template "${name}"${agencySuffix ? ` (${agencySuffix})` : ""}.`;

  return {
    summary,
    templateIndex: templateIndex != null ? templateIndex : undefined,
    beforeName: beforeName || undefined,
    name,
    agencySuffix: agencySuffix || undefined,
    isDefault: !!updated?.isDefault,
    groupsBefore: beforeGroups,
    groupsAfter: afterGroups,
    groupsAdded: added.length ? added : undefined,
    groupsRemoved: removed.length ? removed : undefined,
    groupsCount: Array.isArray(afterGroups) ? afterGroups.length : 0,
    colorOverride: updated?.colorOverride || "",
    role: updated?.role || "Team Member",
    currentTemplateSync,
  };
}

function buildTemplateDeleteDetails(existing, currentTemplateSync) {
  const name = safeStr(existing?.name).trim();
  const agencySuffix = normalizeSuffix(existing?.agencySuffix);
  const userUpdated = Number(currentTemplateSync?.updated || 0);
  return {
    summary: `Deleted template "${name}"${agencySuffix ? ` (${agencySuffix})` : ""}${userUpdated ? `; ${userUpdated} user(s) reset to Manual Group Selection` : ""}.`,
    name,
    agencySuffix: agencySuffix || undefined,
    currentTemplateSync,
  };
}

function buildBulkTemplateGroupAuditDetails(out = {}) {
  const action = out.action === "remove" ? "remove" : "add";
  const groupName = safeStr(out.groupName).trim();
  const verb = action === "remove" ? "Removed" : "Added";
  const touched = Array.isArray(out.touched) ? out.touched : [];
  const templateNames = touched.map((t) =>
    templateTargetId(t.name, t.agencySuffix)
  );
  const capped = capList(templateNames);
  const templatesLabel = capped.items.length
    ? capped.truncated
      ? `${capped.items.join(", ")} …and ${capped.omitted} more`
      : capped.items.join(", ")
    : "(none)";

  const userUpdated = Number(out.currentTemplateSync?.updated || 0);
  const summary = `${verb} group "${groupName}" on template(s): ${templatesLabel}. ${Number(out.updated || 0)} template(s) updated, ${Number(out.skipped || 0)} skipped${userUpdated ? `, ${userUpdated} user(s) synced` : ""}.`;

  return {
    summary,
    action,
    groupName,
    templatesUpdated: out.updated,
    templatesSkipped: out.skipped,
    templateNames: capped.items,
    templateNamesTruncated: capped.truncated || undefined,
    templateNamesTotal: capped.total || undefined,
    templates: touched.map((t) => ({
      name: t.name,
      agencySuffix: t.agencySuffix,
      beforeGroups: t.beforeGroups,
      afterGroups: t.afterGroups,
    })),
    currentTemplateSync: out.currentTemplateSync,
    durationMs: out.durationMs,
    jobId: out.jobId,
  };
}

async function buildMassGroupActionAuditDetails({
  kind,
  payload = {},
  out = {},
  sourceMode,
  targetGroupName,
  durationMs,
  jobId,
} = {}) {
  const mode = sourceMode || inferMassAssignSourceMode(payload);
  const targetGroup = safeStr(targetGroupName).trim();
  const verb = kind === "unassign" ? "Removed from" : "Added to";
  const sourceParts = [];

  let agencyLabels;
  let sourceGroupIds;
  let sourceGroupNames;
  let userIds;
  let usernames;
  let usernamesTruncated;

  if (mode === "agency") {
    agencyLabels = agencyLabelsFromSuffixes(payload.suffixes);
    sourceParts.push(`all users in agencies: ${agencyLabels.join(", ") || "(none)"}`);
  } else if (mode === "group") {
    sourceGroupIds = normalizeIdList(payload.sourceGroupIds ?? payload.sourceGroupId);
    sourceGroupNames = await resolveGroupNames(sourceGroupIds);
    sourceParts.push(`users in source group(s): ${sourceGroupNames.join(", ") || "(none)"}`);
  } else if (mode === "users") {
    userIds = normalizeIdList(payload.userIds);
    const resolved = await resolveUsernames(userIds);
    const capped = capList(resolved);
    usernames = capped.items;
    usernamesTruncated = capped.truncated;
    sourceParts.push(
      capped.truncated
        ? `users: ${capped.items.join(", ")} …and ${capped.omitted} more`
        : `users: ${capped.items.join(", ") || "(none)"}`
    );
  }

  const matched = Number(out?.matched || 0);
  const updated = Number(out?.updated || 0);
  const summary = `${verb} group "${targetGroup || "unknown"}": ${sourceParts.join("; ") || "no source specified"}. Matched ${matched}, updated ${updated}.`;

  return {
    summary,
    targetGroupId: payload.groupId || undefined,
    groupName: targetGroup || undefined,
    name: targetGroup || undefined,
    sourceMode: mode,
    agencySuffixes: mode === "agency" ? payload.suffixes : undefined,
    agencyLabels,
    sourceGroupIds: mode === "group" ? sourceGroupIds : undefined,
    sourceGroupNames,
    userIds: mode === "users" ? userIds : undefined,
    usernames: mode === "users" ? usernames : undefined,
    usernamesTruncated: mode === "users" && usernamesTruncated ? true : undefined,
    matched,
    updated,
    durationMs,
    jobId,
  };
}

function buildMutualAidSummary(action, item) {
  const title = safeStr(item?.title).trim() || "Untitled";
  const type = safeStr(item?.type).trim();
  const groupName = safeStr(item?.groupName).trim();
  const typePart = type ? ` (${type})` : "";
  const groupPart = groupName ? ` — group: ${groupName}` : "";

  if (action === "CREATE_MUTUAL_AID") {
    return `Created mutual aid "${title}"${typePart}${groupPart}.`;
  }
  if (action === "CREATE_MUTUAL_AID_LINKED_USER") {
    return `Created linked mutual aid user "${title}"${typePart}${groupPart}.`;
  }
  if (action === "UPDATE_MUTUAL_AID") {
    return `Updated mutual aid "${title}"${typePart}${groupPart}.`;
  }
  if (action === "DELETE_MUTUAL_AID") {
    return `Deleted mutual aid "${title}"${typePart}${groupPart}.`;
  }
  return "";
}

module.exports = {
  templateTargetId,
  inferMassAssignSourceMode,
  buildTemplateCreateDetails,
  buildTemplateUpdateDetails,
  buildTemplateDeleteDetails,
  buildBulkTemplateGroupAuditDetails,
  buildMassGroupActionAuditDetails,
  buildMutualAidSummary,
};
