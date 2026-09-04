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
        authentik_pk: 9,
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
  console.log("directorySearch.sql.test.js: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
