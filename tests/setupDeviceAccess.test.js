const assert = require("assert");
const router = require("../routes/setupDevice.routes");
const usersSvc = require("../services/users.service");

usersSvc.getUserById = async (id) => ({
  username: String(id),
  is_active: id !== "disabled",
});

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

  console.log("setupDeviceAccess tests passed");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
