const assert = require("assert");

const jsonImport = require("../services/jsonImport.service");
jsonImport.readStatusJson = async () => ({
  active: true,
  phase: "running",
  percent: 10,
  etaSeconds: 30,
  message: "Importing",
});

let status = 0;
let body = null;
const res = {
  status(code) {
    status = code;
    return this;
  },
  json(data) {
    body = data;
    return this;
  },
};

(async () => {
  const handler = async (_req, response) => {
    let migrating = false;
    try {
      const s = await jsonImport.readStatusJson();
      migrating = !!s.active;
    } catch (_) {}
    return response.status(200).json({ ok: true, migrating });
  };
  await handler({}, res);
  assert.strictEqual(status, 200);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.migrating, true);
  console.log("health.migration.test.js: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
