"use strict";

const assert = require("assert");
const {
  createCookieStore,
  attachCookieStore,
  getSharedTakCookieStore,
  resetSharedTakCookieStore,
} = require("../services/takHttpSession");

function fakeClient() {
  const requestFns = [];
  const responseOk = [];
  const responseErr = [];
  return {
    interceptors: {
      request: {
        use(fn) {
          requestFns.push(fn);
        },
      },
      response: {
        use(ok, err) {
          responseOk.push(ok);
          if (err) responseErr.push(err);
        },
      },
    },
    requestFns,
    responseOk,
    responseErr,
  };
}

(async function run() {
  const store = createCookieStore();
  assert.strictEqual(store.header(), "");

  store.applyFromSetCookie("JSESSIONID=abc123; Path=/; HttpOnly");
  assert.deepStrictEqual(store.snapshot(), { JSESSIONID: "abc123" });
  assert.strictEqual(store.header(), "JSESSIONID=abc123");

  store.applyFromSetCookie([
    "JSESSIONID=rotated; Path=/Marti; Secure",
    "other=keep; Path=/",
  ]);
  assert.deepStrictEqual(store.snapshot(), { JSESSIONID: "rotated", other: "keep" });
  assert.strictEqual(store.header(), "JSESSIONID=rotated; other=keep");

  store.applyFromSetCookie("Path=/; HttpOnly");
  assert.deepStrictEqual(store.snapshot(), { JSESSIONID: "rotated", other: "keep" });

  store.applyFromResponseHeaders({
    "set-cookie": ["JSESSIONID=from-headers; Path=/actuator"],
  });
  assert.strictEqual(store.snapshot().JSESSIONID, "from-headers");

  const client = fakeClient();
  const jar = createCookieStore();
  attachCookieStore(client, jar);
  assert.strictEqual(client.requestFns.length, 1);
  assert.strictEqual(client.responseOk.length, 1);

  const cfg = client.requestFns[0]({ headers: {} });
  assert.ok(!cfg.headers.Cookie);

  client.responseOk[0]({
    headers: { "set-cookie": ["JSESSIONID=sess1; Path=/"] },
  });
  const cfg2 = client.requestFns[0]({ headers: {} });
  assert.strictEqual(cfg2.headers.Cookie, "JSESSIONID=sess1");

  const cfg3 = client.requestFns[0]({ headers: { Cookie: "keep-mine=1" } });
  assert.strictEqual(cfg3.headers.Cookie, "keep-mine=1");

  await client.responseErr[0]({
    response: { headers: { "set-cookie": ["JSESSIONID=from-error"] } },
  }).then(
    () => {
      throw new Error("error interceptor should reject");
    },
    () => {
      assert.strictEqual(jar.snapshot().JSESSIONID, "from-error");
    }
  );

  resetSharedTakCookieStore();
  const shared = getSharedTakCookieStore();
  shared.applyFromSetCookie("JSESSIONID=shared");
  assert.strictEqual(getSharedTakCookieStore().header(), "JSESSIONID=shared");
  resetSharedTakCookieStore();
  assert.strictEqual(getSharedTakCookieStore().header(), "");

  console.log("takHttpSession.test.js: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
