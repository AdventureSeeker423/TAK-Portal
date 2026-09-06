const assert = require("assert");

const stackHealth = require("../services/stackHealth.service");
const original = stackHealth.getStackHealth;

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    view: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    render(view, data) {
      this.view = view;
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

const stackHealthGate = require("../services/stackHealthGate.middleware");

(async () => {
  stackHealth.getStackHealth = async () => ({
    ok: false,
    migrating: false,
    postgres: { ok: false, detail: "unreachable" },
    worker: { ok: false, detail: "postgres_down" },
    title: "Portal database is unavailable",
    message: "TAK Portal cannot be used until Postgres is running again.",
  });

  let nextCalled = false;
  const htmlRes = mockRes();
  await stackHealthGate(
    { path: "/users", headers: { accept: "text/html" } },
    htmlRes,
    () => {
      nextCalled = true;
    }
  );
  assert.strictEqual(htmlRes.statusCode, 503);
  assert.strictEqual(htmlRes.view, "stack-down");
  assert.strictEqual(nextCalled, false);

  const jsonRes = mockRes();
  await stackHealthGate(
    { path: "/api/users", headers: { accept: "application/json" } },
    jsonRes,
    () => {
      nextCalled = true;
    }
  );
  assert.strictEqual(jsonRes.statusCode, 503);
  assert.strictEqual(jsonRes.body.error, "stack_unavailable");

  nextCalled = false;
  const healthRes = mockRes();
  await stackHealthGate(
    { path: "/api/system/health", headers: { accept: "application/json" } },
    healthRes,
    () => {
      nextCalled = true;
    }
  );
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(healthRes.statusCode, 200);

  nextCalled = false;
  const rerunRes = mockRes();
  await stackHealthGate(
    { path: "/api/settings/legacy-import/rerun", headers: { accept: "application/json" } },
    rerunRes,
    () => {
      nextCalled = true;
    }
  );
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(rerunRes.statusCode, 200);

  stackHealth.getStackHealth = async () => ({
    ok: true,
    migrating: false,
    postgres: { ok: true },
    worker: { ok: true },
    title: "",
    message: "",
  });
  nextCalled = false;
  const okRes = mockRes();
  await stackHealthGate(
    { path: "/dashboard", headers: { accept: "text/html" } },
    okRes,
    () => {
      nextCalled = true;
    }
  );
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(okRes.statusCode, 200);

  stackHealth.getStackHealth = original;
  console.log("stackHealthGate.test.js: ok");
})().catch((err) => {
  stackHealth.getStackHealth = original;
  console.error(err);
  process.exit(1);
});
