const assert = require("assert");
const { validateCreate } = require("../services/userRequests.service");

function baseOtherPayload(overrides = {}) {
  return {
    firstName: "Jane",
    lastName: "Doe",
    email: "jane.doe@example.gov",
    badgeNumber: "1234",
    radioCallsign: "T01",
    agencySuffix: "__other__",
    otherAgency: "Example Fire Department",
    otherReason: "Mutual aid support",
    groupPrefix: "EFD",
    usernameTokenPlacement: "suffix",
    suffix: "efd",
    state: "OH",
    county: "Hamilton County",
    countyAbbrev: "HM",
    type: "Fire",
    ...overrides,
  };
}

const complete = validateCreate(baseOtherPayload());
assert.strictEqual(complete.agencySuffix, "__other__");
assert.strictEqual(complete.otherAgency, "Example Fire Department");
assert.strictEqual(complete.groupPrefix, "EFD");
assert.strictEqual(complete.suffix, "efd");
assert.strictEqual(complete.state, "OH");
assert.strictEqual(complete.county, "Hamilton");
assert.strictEqual(complete.countyAbbrev, "HM");
assert.strictEqual(complete.type, "Fire");
assert.strictEqual(complete.usernameTokenPlacement, "suffix");

assert.throws(
  () => validateCreate(baseOtherPayload({ groupPrefix: "" })),
  /Agency abbreviation \/ short name is required/
);
assert.throws(
  () => validateCreate(baseOtherPayload({ suffix: "" })),
  /Username Suffix\/Prefix is required/
);
assert.throws(
  () => validateCreate(baseOtherPayload({ state: "" })),
  /State is required/
);
assert.throws(
  () => validateCreate(baseOtherPayload({ county: "" })),
  /County is required/
);
assert.throws(
  () => validateCreate(baseOtherPayload({ countyAbbrev: "H" })),
  /County Abbreviation must be at least 2 characters/
);
assert.throws(
  () => validateCreate(baseOtherPayload({ type: "" })),
  /Agency Type is required/
);
assert.throws(
  () => validateCreate(baseOtherPayload({ otherAgency: "" })),
  /Please enter your agency name/
);
assert.throws(
  () => validateCreate(baseOtherPayload({ otherReason: "" })),
  /Please enter your reason for requesting access/
);

const stateFederal = validateCreate(
  baseOtherPayload({
    stateFederalAgency: "yes",
    county: "",
    countyAbbrev: "",
  })
);
assert.strictEqual(stateFederal.stateFederalAgency, true);
assert.strictEqual(stateFederal.county, "");
assert.strictEqual(stateFederal.countyAbbrev, "");

assert.throws(
  () =>
    validateCreate(
      baseOtherPayload({
        stateFederalAgency: "yes",
        county: "",
        countyAbbrev: "H",
      })
    ),
  /County Abbreviation must be at least 2 characters/
);

const prefixed = validateCreate(
  baseOtherPayload({ usernameTokenPlacement: "prefix" })
);
assert.strictEqual(prefixed.usernameTokenPlacement, "prefix");

console.log("userRequestsOtherAgency.test.js: ok");
