const assert = require("assert");
const fs = require("fs");
const path = require("path");
const router = require("../routes/setupDevice.routes");
const usersSvc = require("../services/users.service");

usersSvc.getUserById = async (id) => {
  if (id === "missing") return null;
  if (id === "error") throw new Error("directory unavailable");
  if (id === "active" || id === "disabled") {
    return { username: String(id), is_active: id !== "disabled" };
  }
  // Simulate Authentik uid that does not match local id / authentik_pk.
  return null;
};

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
assert.ok(
  /setup-my-device[\s\S]{0,1200}is_active\s*===\s*false/.test(serverSrc) ||
    /is_active\s*===\s*false[\s\S]{0,400}enrollQrBootstrap/.test(serverSrc),
  "setup-my-device page must refuse enroll QR bootstrap for disabled users"
);
const setupViewSrc = fs.readFileSync(
  path.join(__dirname, "..", "views", "setup-my-device.ejs"),
  "utf8"
);
assert.ok(
  setupViewSrc.includes("Account is disabled") || setupViewSrc.includes("clearEnrollCache"),
  "setup-my-device client must clear cached QR when enroll is denied"
);

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

  // Authentik uid often does not match local id/authentik_pk; username must still resolve.
  const uidMissReq = {
    authentikUser: { uid: "00000000-0000-4000-8000-000000000099", username: "active" },
  };
  const uidMissRes = response();
  const uidMiss = await router.requireActiveLoggedIn(uidMissReq, uidMissRes);
  assert.strictEqual(uidMiss.username, "active");
  assert.strictEqual(uidMissRes.statusCode, 200);

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
