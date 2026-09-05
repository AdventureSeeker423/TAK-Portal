"use strict";

const assert = require("assert");
const qrSvc = require("../services/qr.service");

(async function run() {
  const url =
    "tak://com.atakmap.app/preference?key1=locationCallsign&type1=string&value1=TEST-1";
  const first = await qrSvc.generateDisplayQrDataUrl(url);
  const second = await qrSvc.generateDisplayQrDataUrl(url);
  assert.ok(first.startsWith("data:image/png;base64,"));
  assert.strictEqual(second, first, "repeat display QR generation should hit the in-memory cache");
  assert.ok(qrSvc.displayQrCacheKey(url));
  assert.notStrictEqual(
    qrSvc.displayQrCacheKey(url),
    qrSvc.displayQrCacheKey(url + "&extra=1")
  );
  console.log("qr.cache.test.js: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
