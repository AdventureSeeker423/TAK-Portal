/**
 * Enable/disable an agency and cascade user active state in Authentik.
 */

const agenciesStore = require("./agencies.service");
const usersService = require("./users.service");

async function listActiveUserIdsForAgencyName(agencyName) {
  const users = await usersService.listAllUsersByAgencyName(agencyName);
  return users
    .filter((u) => u?.is_active && (u?.pk != null || u?.id != null))
    .map((u) => String(u.pk ?? u.id));
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
    const userIds = await listActiveUserIdsForAgencyName(agencyName);
    const affectedIds = [];
    const failures = [];

    for (const userId of userIds) {
      try {
        await usersService.toggleUserActive(userId, false);
        affectedIds.push(String(userId));
      } catch (err) {
        failures.push({
          userId: String(userId),
          error: err?.message || String(err),
        });
      }
    }

    if (failures.length) {
      const detail = failures
        .slice(0, 5)
        .map((f) => `${f.userId}: ${f.error}`)
        .join(" | ");
      throw new Error(
        `Failed to disable ${failures.length} user(s) for this agency. ${detail}${
          failures.length > 5 ? " | …" : ""
        }`
      );
    }

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
  let usersUpdated = 0;
  const failures = [];

  for (const userId of storedIds) {
    try {
      const user = await usersService.getUserById(userId);
      if (user && !user.is_active) {
        await usersService.toggleUserActive(userId, true);
        usersUpdated += 1;
      }
    } catch (err) {
      failures.push({
        userId: String(userId),
        error: err?.message || String(err),
      });
    }
  }

  if (failures.length) {
    const detail = failures
      .slice(0, 5)
      .map((f) => `${f.userId}: ${f.error}`)
      .join(" | ");
    throw new Error(
      `Failed to re-enable ${failures.length} user(s) for this agency. ${detail}${
        failures.length > 5 ? " | …" : ""
      }`
    );
  }

  agencies[idx] = {
    ...agency,
    isActive: true,
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

module.exports = {
  setAgencyActive,
};
