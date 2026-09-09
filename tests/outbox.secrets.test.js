const assert = require("node:assert/strict");
const outbox = require("../services/authentikOutbox.service");
const api = require("../services/authentik");
const db = require("../services/db");
const { handleOutboxRow } = require("../services/directorySync.service");

(async () => {
  let failures = 0;
  async function check(name, run) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
  }
  require("../services/settings.service").ensureSettingsInitialized();
  const secrets = require("../services/cryptoSecrets");
  secrets.getKeyBuffer({ allowCreate: true });
  const bad = "v1:" + Buffer.alloc(12).toString("base64") + ":" + Buffer.alloc(16).toString("base64") + ":YQ==";
  await check("malformed encrypted envelopes are rejected", () => {
    assert.throws(() => secrets.decryptSecret("v1:broken"), /encrypted/i);
  });
  for (const field of ["password", "token", "key", "secret", "app_password", "password_enc"]) {
    await check(`${field}: corrupt secrets must not become empty strings`, () => {
      assert.throws(() => outbox.decryptPayload({ [field]: bad }), /decrypt|encrypted|cipher|key|authenticate/i);
    });
  }
  let posts = 0;
  api.post = async () => { posts++; return { data: { pk: 42 } }; };
  await check("corrupt password rejects before creating an Authentik account", async () => {
    await assert.rejects(handleOutboxRow({ kind: "create_user", payload: {
      username: "fixture", name: "Fixture", password: bad,
    } }));
    assert.equal(posts, 0);
  });
  await check("intentional passwordless creation remains supported", async () => {
    posts = 0;
    await handleOutboxRow({ kind: "create_user", payload: { username: "fixture", name: "Fixture" } });
    assert.equal(posts, 1);
  });
  await check("failed outbox operation reports failure", async () => {
    db.query = async () => ({ rows: [{ last_error: "fixture failure", attempts: 1 }] });
    await assert.rejects(outbox.waitForOutbox(1, 10), /failed|retry|error/i);
  });
  await check("pending outbox operation is not success", async () => {
    db.query = async () => ({ rows: [{ last_error: null, attempts: 0 }] });
    await assert.rejects(outbox.waitForOutbox(1, 10), /pending|timed out/i);
  });
  await check("completed outbox operation still succeeds", async () => {
    db.query = async () => ({ rows: [] });
    assert.deepEqual(await outbox.waitForOutbox(1), { done: true, timedOut: false });
  });
  assert.equal(failures, 0, "outbox secret regression failures");
})().catch((error) => { console.error(error); process.exitCode = 1; });
