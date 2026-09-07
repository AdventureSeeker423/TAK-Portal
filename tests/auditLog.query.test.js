const assert = require("assert");

const sqlCalls = [];
const db = require("../services/db");
db.isConfigured = () => true;
db.query = async (sql, params) => {
  sqlCalls.push({ sql, params: params || [] });
  if (/COUNT\(\*\)/.test(sql)) return { rows: [{ n: 3 }] };
  return {
    rows: [
      {
        id: "1",
        timestamp: "2026-01-01T12:00:00.000Z",
        actor: { username: "admin" },
        request: {},
        action: "USER_CREATED",
        target_type: "user",
        target_id: "u1",
        agency_suffix: "so",
        agency_name: "Sheriff",
        agency_prefix: "SO",
        details: {},
      },
    ],
  };
};

const store = require("../services/auditLog.store");

(async () => {
  sqlCalls.length = 0;
  const r = await store.queryRows({ q: "john", page: 5, pageSize: 50 });
  assert.strictEqual(r.total, 3);
  assert.strictEqual(
    r.page,
    1,
    "requesting a high page with a tight search must clamp to the filtered page count"
  );

  const countSql = sqlCalls.find((c) => /COUNT\(\*\)/.test(c.sql));
  const listSql = sqlCalls.find((c) => /LIMIT/.test(c.sql));
  assert.ok(countSql, "filtered query should COUNT matching events");
  assert.ok(listSql, "filtered query should LIMIT/OFFSET after WHERE");
  assert.ok(/ILIKE/.test(countSql.sql), "search must apply in COUNT, not only the current page");
  assert.ok(/ILIKE/.test(listSql.sql), "search must apply in the paged SELECT");
  assert.ok(
    /agency_suffix/.test(countSql.sql) && /agency_name/.test(countSql.sql),
    "search should include agency fields"
  );
  assert.ok(countSql.params.some((p) => String(p).includes("john")));
  const offset = listSql.params[listSql.params.length - 1];
  assert.strictEqual(offset, 0, "clamped page 1 must use OFFSET 0, not an empty later page");

  sqlCalls.length = 0;
  await store.queryRows({
    q: "badge",
    actorNeedles: ["admin"],
    actionNeedles: ["user_created"],
    page: 2,
    pageSize: 50,
  });
  const mixedCount = sqlCalls.find((c) => /COUNT\(\*\)/.test(c.sql));
  assert.ok(/ILIKE/.test(mixedCount.sql), "search + actor/action filters share one COUNT");
  assert.ok(/actor->>'username'/.test(mixedCount.sql));
  assert.ok(/LOWER\(COALESCE\(action,''\)\)/.test(mixedCount.sql));

  sqlCalls.length = 0;
  await store.queryRows({ from: "2026-09-01", to: "2026-09-06", page: 1, pageSize: 50 });
  const dateCount = sqlCalls.find((c) => /COUNT\(\*\)/.test(c.sql));
  assert.ok(dateCount.params.includes("2026-09-01T00:00:00.000Z"));
  assert.ok(
    dateCount.params.includes("2026-09-06T23:59:59.999Z"),
    "date-only 'to' must include the whole day"
  );

  sqlCalls.length = 0;
  await store.queryRows({ from: "2026", to: "2026", page: 1, pageSize: 50 });
  const yearCount = sqlCalls.find((c) => /COUNT\(\*\)/.test(c.sql));
  assert.ok(yearCount.params.includes("2026-01-01T00:00:00.000Z"), "year-only from starts Jan 1");
  assert.ok(yearCount.params.includes("2026-12-31T23:59:59.999Z"), "year-only to ends Dec 31");

  sqlCalls.length = 0;
  await store.queryRows({ from: "2026-09", to: "2026-09", page: 1, pageSize: 50 });
  const monthCount = sqlCalls.find((c) => /COUNT\(\*\)/.test(c.sql));
  assert.ok(monthCount.params.includes("2026-09-01T00:00:00.000Z"), "year-month from starts the 1st");
  assert.ok(monthCount.params.includes("2026-09-30T23:59:59.999Z"), "year-month to ends last day of month");

  console.log("auditLog.query.test.js: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
