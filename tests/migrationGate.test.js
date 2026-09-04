const assert = require("assert");
const path = require("path");

const jsonImport = require("../services/jsonImport.service");
const originalRead = jsonImport.readStatusJson;
jsonImport.readStatusJson = async () => ({
  active: true,
  phase: "running",
  percent: 40,
  etaSeconds: 12,
  message: "Importing",
});

const migrationGate = require("../services/migrationGate.middleware");

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    render(_view, data) {
      this.body = data;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
    setHeader(k, v) {
      this.headers[k] = v;
    },
  };
  return res;
}

(async () => {
  let nextCalled = false;
  const htmlRes = mockRes();
  await migrationGate(
    { path: "/users", headers: { accept: "text/html" } },
    htmlRes,
    () => {
      nextCalled = true;
    }
  );
  assert.strictEqual(htmlRes.statusCode, 503);
  assert.strictEqual(nextCalled, false);

  const jsonRes = mockRes();
  await migrationGate(
    { path: "/api/users", headers: { accept: "application/json" } },
    jsonRes,
    () => {
      nextCalled = true;
    }
  );
  assert.strictEqual(jsonRes.statusCode, 503);
  assert.strictEqual(jsonRes.body.error, "migration_in_progress");

  nextCalled = false;
  const healthRes = mockRes();
  await migrationGate(
    { path: "/api/system/health", headers: { accept: "application/json" } },
    healthRes,
    () => {
      nextCalled = true;
    }
  );
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(healthRes.statusCode, 200);

  jsonImport.readStatusJson = originalRead;
  console.log("migrationGate.test.js: ok");
})().catch((err) => {
  jsonImport.readStatusJson = originalRead;
  console.error(err);
  process.exit(1);
});
