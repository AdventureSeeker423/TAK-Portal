const assert = require("assert");
const pgCache = require("../services/pgCache");
const templatesSvc = require("../services/templates.service");
const agenciesSvc = require("../services/agencies.service");
const { shouldAutoApproveRequest } = require("../services/userRequests.service");

const originalTemplates = pgCache.caches.templates;
pgCache.caches.templates = [
  { name: "Firefighter", agencySuffix: "cfd", isDefault: true },
  { name: "Officer", agencySuffix: "cfd", isDefault: false },
  { name: "Medic", agencySuffix: "ems", isDefault: false },
];

try {
  const def = templatesSvc.getDefaultTemplateForAgency("CFD");
  assert.ok(def);
  assert.strictEqual(def.name, "Firefighter");
  assert.strictEqual(templatesSvc.getDefaultTemplateForAgency("ems"), null);
  assert.strictEqual(templatesSvc.getDefaultTemplateForAgency(""), null);

  agenciesSvc.assertAgencyCanEnableAutoApprove({ suffix: "cfd" });
  assert.throws(
    () => agenciesSvc.assertAgencyCanEnableAutoApprove({ suffix: "ems" }),
    /default template/i
  );

  const agencyOn = {
    suffix: "cfd",
    autoApproveRequests: true,
    lookupDomain: "agency.gov, county.org",
  };
  const validatedMatch = {
    agencySuffix: "cfd",
    email: "user@agency.gov",
  };
  const validatedMiss = {
    agencySuffix: "cfd",
    email: "user@gmail.com",
  };
  assert.strictEqual(shouldAutoApproveRequest(agencyOn, validatedMatch), true);
  assert.strictEqual(shouldAutoApproveRequest(agencyOn, validatedMiss), false);

  const agencyAnyDomain = {
    suffix: "cfd",
    autoApproveRequests: true,
    lookupDomain: "",
  };
  assert.strictEqual(
    shouldAutoApproveRequest(agencyAnyDomain, { agencySuffix: "cfd", email: "anyone@gmail.com" }),
    true
  );

  const agencyOff = { suffix: "cfd", autoApproveRequests: false, lookupDomain: "" };
  assert.strictEqual(
    shouldAutoApproveRequest(agencyOff, { agencySuffix: "cfd", email: "user@agency.gov" }),
    false
  );

  const noDefaultAgency = {
    suffix: "ems",
    autoApproveRequests: true,
    lookupDomain: "",
  };
  assert.strictEqual(
    shouldAutoApproveRequest(noDefaultAgency, { agencySuffix: "ems", email: "user@ems.gov" }),
    false
  );

  assert.strictEqual(
    shouldAutoApproveRequest(agencyOn, { agencySuffix: "__other__", email: "user@agency.gov" }),
    false
  );

  console.log("agencyAutoApprove.test.js: ok");
} catch (err) {
  console.error(err);
  process.exit(1);
} finally {
  pgCache.caches.templates = originalTemplates;
}
