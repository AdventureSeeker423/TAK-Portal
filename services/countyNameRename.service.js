/**
 * Rename a county full name for all agencies in the same state and rename county TAK groups.
 */

const agenciesStore = require("./agencies.service");
const groupsService = require("./groups.service");

function toTitleCaseWords(s) {
  return String(s || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function normalizeCountyName(raw) {
  let v = String(raw || "").trim().replace(/\s+/g, " ");
  if (!v) return "";
  const lower = v.toLowerCase();
  if (lower.endsWith(" county")) {
    const base = v.slice(0, lower.lastIndexOf(" county"));
    return toTitleCaseWords(base);
  }
  return toTitleCaseWords(v);
}

function stripTakPrefix(name) {
  const n = String(name || "").trim();
  return n.toLowerCase().startsWith("tak_") ? n.slice(4) : n;
}

function withTakPrefix(name, hadTak) {
  const n = String(name || "").trim();
  if (!n) return "";
  if (!hadTak) return n;
  return n.toLowerCase().startsWith("tak_") ? n : `tak_${n}`;
}

function computeRenamedCountyGroupName(groupName, oldCounty, newCounty) {
  const raw = String(groupName || "").trim();
  if (!raw) return null;

  const hadTak = raw.toLowerCase().startsWith("tak_");
  const withoutTak = stripTakPrefix(raw);

  let behaviorSuffix = "";
  let base = withoutTak;
  if (base.endsWith("_READ")) {
    behaviorSuffix = "_READ";
    base = base.slice(0, -5);
  } else if (base.endsWith("_WRITE")) {
    behaviorSuffix = "_WRITE";
    base = base.slice(0, -6);
  }

  const oldC = String(oldCounty || "").trim();
  const newC = String(newCounty || "").trim();
  if (!oldC || !newC) return null;

  const legacyPrefix = `${oldC} Co - `;
  if (base.startsWith(legacyPrefix)) {
    const rest = base.slice(legacyPrefix.length);
    return withTakPrefix(`${newC} Co - ${rest}${behaviorSuffix}`, hadTak);
  }

  const modernPrefix = `${oldC} Co `;
  if (base.toLowerCase().startsWith(modernPrefix.toLowerCase())) {
    const rest = base.slice(modernPrefix.length);
    return withTakPrefix(`${newC} Co ${rest}${behaviorSuffix}`, hadTak);
  }

  return null;
}

function isAgencyAdminGroupName(name) {
  return /-agencyadmin$/i.test(String(name || "").trim());
}

async function renameCountyTakGroups(oldCounty, newCounty) {
  const oldC = String(oldCounty || "").trim();
  const newC = String(newCounty || "").trim();
  if (!oldC || !newC || oldC.toLowerCase() === newC.toLowerCase()) {
    return { groupsRenamed: 0 };
  }

  const allGroups = await groupsService.getAllGroups({ includeHidden: true });
  let groupsRenamed = 0;

  for (const g of Array.isArray(allGroups) ? allGroups : []) {
    const gn = String(g?.name || "").trim();
    const gid = String(g?.pk ?? g?.id ?? "").trim();
    if (!gn || !gid) continue;
    if (isAgencyAdminGroupName(gn)) continue;

    const attrs = g?.attributes && typeof g.attributes === "object" ? g.attributes : {};
    const createdType = String(attrs.created_type || "").trim().toLowerCase();
    const detail = String(attrs.created_type_detail || "").trim();
    const nextName = computeRenamedCountyGroupName(gn, oldC, newC);
    const isCountyByAttr =
      createdType === "county" && detail.toLowerCase() === oldC.toLowerCase();
    const isCountyByName = !!nextName;

    if (!isCountyByAttr && !isCountyByName) continue;

    const finalName = nextName || gn;
    const nextAttrs = { ...attrs };
    if (isCountyByAttr) {
      nextAttrs.created_type = attrs.created_type || "County";
      nextAttrs.created_type_detail = newC;
    }

    const nameChanged = finalName !== gn;
    const detailChanged =
      isCountyByAttr &&
      String(nextAttrs.created_type_detail || "").trim().toLowerCase() !==
        detail.toLowerCase();
    if (!nameChanged && !detailChanged) continue;

    await groupsService.patchGroupNameAndCn(gid, finalName, {
      skipActionLock: true,
      attributes: {
        created_type: nextAttrs.created_type,
        created_type_detail: nextAttrs.created_type_detail,
        description: nextAttrs.description,
        private: nextAttrs.private,
      },
    });
    groupsRenamed += 1;
  }

  return { groupsRenamed };
}

/**
 * @param {number} agencyIndex - index in agencies.json
 * @param {string} newCountyRaw - new county full name
 */
async function renameCountyName(agencyIndex, newCountyRaw) {
  const idx = Number(agencyIndex);
  const agencies = agenciesStore.load();
  if (!Number.isInteger(idx) || !agencies[idx]) {
    throw new Error("Agency not found");
  }

  const agency = agencies[idx];
  const targetState = String(agency.state || "").trim().toUpperCase();
  if (!targetState) {
    throw new Error("Agency state is missing");
  }

  const oldCounty = normalizeCountyName(agency.county);
  const newCounty = normalizeCountyName(newCountyRaw);
  const allowEmpty = !!agency.stateFederalAgency;
  if (!newCounty && !allowEmpty) {
    throw new Error("County name is required");
  }

  // Clearing county for a State/Federal agency: update this agency only (no group rename).
  if (!newCounty && allowEmpty) {
    if (!oldCounty) {
      return {
        success: true,
        skipped: true,
        state: targetState,
        oldCounty,
        newCounty: "",
        updatedIndexes: [idx],
        groupsRenamed: 0,
      };
    }
    agencies[idx] = { ...agencies[idx], county: "" };
    agenciesStore.save(agencies);
    groupsService.invalidateGroupsCache();
    return {
      success: true,
      skipped: false,
      state: targetState,
      oldCounty,
      newCounty: "",
      updatedIndexes: [idx],
      groupsRenamed: 0,
    };
  }

  const targetCountyKey = String(oldCounty || "").trim().toLowerCase();
  const matchingIndexes = [];
  for (let i = 0; i < agencies.length; i++) {
    const ag = agencies[i];
    if (!ag) continue;
    const c = normalizeCountyName(ag.county);
    const s = String(ag.state || "").trim().toUpperCase();
    if (s === targetState && String(c || "").trim().toLowerCase() === targetCountyKey) {
      matchingIndexes.push(i);
    }
  }

  if (!matchingIndexes.length) {
    throw new Error("No matching agencies found for this county");
  }

  const allAlreadySet = matchingIndexes.every((i) => {
    const current = normalizeCountyName(agencies[i]?.county);
    return String(current || "").trim().toLowerCase() === newCounty.toLowerCase();
  });
  if (allAlreadySet) {
    return {
      success: true,
      skipped: true,
      state: targetState,
      oldCounty,
      newCounty,
      updatedIndexes: matchingIndexes,
      groupsRenamed: 0,
    };
  }

  const conflict = agencies.some((ag, i) => {
    if (matchingIndexes.includes(i)) return false;
    const s = String(ag.state || "").trim().toUpperCase();
    const c = normalizeCountyName(ag.county);
    return s === targetState && String(c || "").trim().toLowerCase() === newCounty.toLowerCase();
  });
  if (conflict) {
    throw new Error(`County "${newCounty}" already exists in ${targetState}`);
  }

  const groupStats = await renameCountyTakGroups(oldCounty, newCounty);

  for (const i of matchingIndexes) {
    agencies[i] = { ...agencies[i], county: newCounty };
  }
  agenciesStore.save(agencies);
  groupsService.invalidateGroupsCache();

  return {
    success: true,
    skipped: false,
    state: targetState,
    oldCounty,
    newCounty,
    updatedIndexes: matchingIndexes,
    groupsRenamed: groupStats.groupsRenamed,
  };
}

module.exports = {
  normalizeCountyName,
  renameCountyName,
};
