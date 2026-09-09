const assert = require("assert");
const router = require("../routes/setupDevice.routes");
const usersSvc = require("../services/users.service");

usersSvc.getUserById = async (id) => {
  if (id === "missing") return null;
  if (id === "error") throw new Error("directory unavailable");
  return { username: String(id), is_active: id !== "disabled" };
};

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

(async () => {
  assert.strictEqual(typeof router.requireActiveLoggedIn, "function");

  const activeReq = { authentikUser: { uid: "active", username: "active" } };
  const activeRes = response();
  const active = await router.requireActiveLoggedIn(activeReq, activeRes);
  assert.strictEqual(active.username, "active");
  assert.strictEqual(activeRes.statusCode, 200);

  const disabledReq = { authentikUser: { uid: "disabled", username: "disabled" } };
  const disabledRes = response();
  const disabled = await router.requireActiveLoggedIn(disabledReq, disabledRes);
  assert.strictEqual(disabled, null);
  assert.strictEqual(disabledRes.statusCode, 403);
  assert.deepStrictEqual(disabledRes.body, {
    ok: false,
    error: "Account is disabled",
  });

  const missingReq = { authentikUser: { uid: "missing", username: "missing" } };
  const missingRes = response();
  const missing = await router.requireActiveLoggedIn(missingReq, missingRes);
  assert.strictEqual(missing, null);
  assert.strictEqual(missingRes.statusCode, 403);
  assert.deepStrictEqual(missingRes.body, {
    ok: false,
    error: "Account is disabled",
  });

  const errorReq = { authentikUser: { uid: "error", username: "error" } };
  const errorRes = response();
  await assert.rejects(
    () => router.requireActiveLoggedIn(errorReq, errorRes),
    /directory unavailable/
  );
  assert.strictEqual(errorRes.statusCode, 200);

  console.log("setupDeviceAccess tests passed");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
