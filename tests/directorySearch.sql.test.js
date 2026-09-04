const assert = require("assert");

const sqlCalls = [];
const db = require("../services/db");
db.query = async (sql, params) => {
  sqlCalls.push({ sql, params });
  if (/COUNT\(\*\)/.test(sql)) return { rows: [{ n: 3 }] };
  if (/FROM group_members/.test(sql)) return { rows: [] };
  return {
    rows: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        authentik_pk: "08078bff-cca2-4b47-b4aa-fd87229168ef",
        username: "badge.so",
        name: "Officer",
        email: "a@example.com",
        is_active: true,
        is_superuser: false,
        path: null,
        type: null,
        attributes: {},
        pending_delete: false,
        sync_status: "ok",
      },
    ],
  };
};

const directoryRepo = require("../services/directoryRepo.service");

(async () => {
  const r = await directoryRepo.searchUsersPaged({
    q: "badge",
    page: 1,
    pageSize: 25,
    includeGroups: false,
  });
  assert.strictEqual(r.pageSize, 25);
  assert.strictEqual(r.total, 3);
  assert.ok(r.users.length >= 1);
  const countSql = sqlCalls.find((c) => /COUNT\(\*\)/.test(c.sql));
  const listSql = sqlCalls.find((c) => /LIMIT/.test(c.sql) && /FROM users/.test(c.sql));
  assert.ok(countSql, "paged search should COUNT matching users");
  assert.ok(listSql, "paged search should LIMIT/OFFSET rather than select all users");
  assert.ok(/ILIKE/.test(countSql.sql), "search should use SQL ILIKE");
  assert.ok(!/SELECT \* FROM users$/.test(listSql.sql.trim()));

  sqlCalls.length = 0;
  const agency = await directoryRepo.searchUsersPaged({
    agencySuffix: "so",
    page: 1,
    pageSize: 25,
    includeGroups: false,
  });
  assert.strictEqual(agency.total, 3);
  const agencyCount = sqlCalls.find((c) => /COUNT\(\*\)/.test(c.sql));
  assert.ok(agencyCount, "agency search should COUNT matching users");
  assert.ok(/lower\(agency\)/.test(agencyCount.sql), "agency filter should COUNT by users.agency");
  assert.ok(agencyCount.params.includes("so"));

  sqlCalls.length = 0;
  const emptyAgency = await directoryRepo.searchUsersPaged({
    agencySuffixes: [],
    page: 1,
    pageSize: 25,
    includeGroups: false,
  });
  assert.strictEqual(emptyAgency.total, 0);
  assert.strictEqual(emptyAgency.users.length, 0);
  assert.ok(!sqlCalls.some((c) => /COUNT\(\*\)/.test(c.sql)), "empty agency list should not query");

  sqlCalls.length = 0;
  const groups = await directoryRepo.searchGroupsPaged({
    q: "tak",
    page: 1,
    pageSize: 25,
  });
  assert.strictEqual(groups.pageSize, 25);
  assert.strictEqual(groups.total, 3);
  const groupCount = sqlCalls.find((c) => /COUNT\(\*\)/.test(c.sql) && /FROM groups/.test(c.sql));
  const groupList = sqlCalls.find((c) => /LIMIT/.test(c.sql) && /FROM groups/.test(c.sql));
  assert.ok(groupCount, "paged group search should COUNT matching groups");
  assert.ok(groupList, "paged group search should LIMIT/OFFSET rather than select all groups");

  sqlCalls.length = 0;
  const emails = await directoryRepo.listUserEmailRowsByGroupPks(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
  assert.ok(Array.isArray(emails));
  const memberSql = sqlCalls.find((c) => /group_members/.test(c.sql));
  assert.ok(memberSql, "group recipient lookup should join group_members");

  sqlCalls.length = 0;
  const pks = await directoryRepo.listUserPksByAgencySuffixes(["so"]);
  assert.ok(Array.isArray(pks));
  const pkSql = sqlCalls.find((c) => /COALESCE\(authentik_pk/.test(c.sql) && /lower\(agency\)/.test(c.sql));
  assert.ok(pkSql, "agency mass-assign should select user pks by agency suffix");

  const { extractUserColumns, extractGroupColumns } = require("../services/userAttributes.util");
  const userCols = extractUserColumns({
    agency: "so",
    agencyAbbreviation: "SO",
    radio_callsign: "UNIT1",
    current_template: "Patrol",
  });
  assert.strictEqual(userCols.agency, "so");
  assert.strictEqual(userCols.agency_abbreviation, "SO");
  assert.strictEqual(userCols.radio_callsign, "UNIT1");
  assert.strictEqual(userCols.current_template, "Patrol");

  const groupCols = extractGroupColumns({
    CN: "SO Patrol",
    private: "yes",
    description: "Night shift",
    created_type: "Agency",
    created_type_detail: "Sheriff",
  });
  assert.strictEqual(groupCols.cn, "SO Patrol");
  assert.strictEqual(groupCols.is_private, true);
  assert.strictEqual(groupCols.description, "Night shift");
  assert.strictEqual(groupCols.created_type, "Agency");
  assert.strictEqual(groupCols.created_type_detail, "Sheriff");

  console.log("directorySearch.sql.test.js: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
