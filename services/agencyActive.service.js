/**
 * Enable/disable an agency and cascade user active state in Authentik.
 */

const agenciesStore = require("./agencies.service");
const usersService = require("./users.service");

async function listActiveUsersForAgencyName(agencyName) {
  return usersService.listAllUsersByAgencyName(agencyName, { activeOnly: true });
}

async function setAgencyActive(agencyIndex, isActive) {
  const idx = Number(agencyIndex);
  const agencies = agenciesStore.load();
  if (!Number.isInteger(idx) || !agencies[idx]) {
    throw new Error("Agency not found");
  }

  const agency = agencies[idx];
  const suffix = String(agency.suffix || "").trim().toLowerCase();
  const agencyName = String(agency.name || "").trim();
  if (!agencyName) throw new Error("Agency name is missing");

  const wasActive = agenciesStore.isAgencyActive(agency);
  const targetActive = !!isActive;

  if (wasActive === targetActive) {
    return {
      success: true,
      skipped: true,
      isActive: targetActive,
      suffix,
      agencyName,
      usersUpdated: 0,
    };
  }

  if (!targetActive) {
    const users = await listActiveUsersForAgencyName(agencyName);
    const { affectedIds } = await usersService.bulkDisableUsersForAgency(users);

    agencies[idx] = {
      ...agency,
      isActive: false,
      agencyDisabledUserIds: affectedIds,
    };
    agenciesStore.save(agencies);

    return {
      success: true,
      skipped: false,
      isActive: false,
      suffix,
      agencyName,
      usersUpdated: affectedIds.length,
      agencyDisabledUserIds: affectedIds,
    };
  }

  const storedIds = Array.isArray(agency.agencyDisabledUserIds)
    ? agency.agencyDisabledUserIds.map(String).filter(Boolean)
    : [];

  // Mark the agency active before re-enabling users so enable checks pass.
  agencies[idx] = {
    ...agency,
    isActive: true,
    agencyDisabledUserIds: storedIds,
  };
  agenciesStore.save(agencies);

  let usersUpdated = 0;
  try {
    const out = await usersService.bulkEnableUsersForAgency(storedIds);
    usersUpdated = out.usersUpdated;
  } catch (err) {
    agencies[idx] = {
      ...agencies[idx],
      isActive: false,
      agencyDisabledUserIds: storedIds,
    };
    agenciesStore.save(agencies);
    throw err;
  }

  agencies[idx] = {
    ...agencies[idx],
    agencyDisabledUserIds: [],
  };
  agenciesStore.save(agencies);

  return {
    success: true,
    skipped: false,
    isActive: true,
    suffix,
    agencyName,
    usersUpdated,
    agencyDisabledUserIds: [],
  };
}

async function getAgencyActiveChangePreview(agencyIndex) {
  const idx = Number(agencyIndex);
  const agencies = agenciesStore.load();
  if (!Number.isInteger(idx) || !agencies[idx]) {
    throw new Error("Agency not found");
  }

  const agency = agencies[idx];
  const agencyName = String(agency.name || "").trim();
  const enabling = !agenciesStore.isAgencyActive(agency);

  if (enabling) {
    const ids = Array.isArray(agency.agencyDisabledUserIds)
      ? agency.agencyDisabledUserIds.map(String).filter(Boolean)
      : [];
    return {
      enabling: true,
      userCount: ids.length,
      agencyName,
    };
  }

  if (!agencyName) {
    return { enabling: false, userCount: 0, agencyName: "" };
  }

  const users = await listActiveUsersForAgencyName(agencyName);
  return {
    enabling: false,
    userCount: users.length,
    agencyName,
  };
}

module.exports = {
  setAgencyActive,
  getAgencyActiveChangePreview,
};
