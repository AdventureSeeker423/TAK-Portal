const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const oa = require("../services/openaddresses.service");

const FIXTURE_CSV = [
  "LON,LAT,NUMBER,STREET,UNIT,CITY,DISTRICT,REGION,POSTCODE,ID,HASH",
  "-85.3097,35.0456,600,Market St,,Chattanooga,,TN,37402,1,abc",
  "-85.3101,35.0496,6125,Preservation Drive,,Chattanooga,,TN,37416,2,def",
  "-86.7816,36.1627,100,Broadway,,Nashville,,TN,37201,3,ghi",
].join("\n");

assert.strictEqual(
  oa.buildAddressLabel({
    number: "600",
    street: "Market St",
    city: "Chattanooga",
    region: "TN",
    postcode: "37402",
  }),
  "600 Market St, Chattanooga, TN, 37402"
);
assert.strictEqual(oa.isAddressCsvPath("us/tn/hamilton.csv"), true);
assert.strictEqual(oa.isAddressCsvPath("us/tn/hamilton-parcels.csv"), false);
assert.strictEqual(oa.isAddressCsvPath("us/tn/chattanooga-buildings.csv"), false);
assert.strictEqual(oa.toFtsQuery("600 Market St"), "600* AND market* AND st*");
assert.ok(oa.isGlobalCollection({ name: "global", size: 1 }));
assert.ok(oa.isGlobalCollection({ name: "us-south", size: 55 * 1024 * 1024 * 1024 }));
assert.strictEqual(oa.isGlobalCollection({ name: "us-south", size: 12 * 1024 * 1024 * 1024 }), false);

const header = oa.headerIndexMap(oa.parseCsvLine("LON,LAT,NUMBER,STREET,CITY,REGION,POSTCODE"));
const rec = oa.rowToRecord(
  oa.parseCsvLine("-85.3,35.04,600,Market St,Chattanooga,TN,37402"),
  header
);
assert.ok(rec);
assert.strictEqual(rec.lat, 35.04);
assert.ok(rec.label.includes("600 Market St"));

(async function run() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch (err) {
    throw new Error("node:sqlite is required for OpenAddresses tests (Node.js 22+): " + (err && err.message));
  }
  assert.ok(DatabaseSync);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tak-oa-"));
  const catalog = [
    {
      id: 2,
      name: "us-northeast",
      human: "US Northeast",
      created: 2000,
      size: 2048,
      sources: ["us/ny/**"],
    },
  ];
  const svc = oa.createOpenAddressesService({
    rootDir: tmp,
    getToken() {
      return "";
    },
    fetch: async function (url) {
      if (String(url).includes("/api/collections") && !String(url).includes("/data")) {
        return {
          ok: true,
          json: async function () {
            return catalog;
          },
        };
      }
      throw new Error("unexpected fetch " + url);
    },
  });

  try {
    const emptyStatus = await svc.getStatus({ forceCatalog: true });
    assert.strictEqual(emptyStatus.indexReady, false);
    assert.strictEqual(emptyStatus.hasToken, false);
    assert.strictEqual(emptyStatus.collections.length, 1);
    assert.strictEqual(emptyStatus.collections[0].status, "not_installed");
    assert.strictEqual(svc.isIndexReady(), false);
    assert.deepStrictEqual(svc.search("600 Market"), []);

    assert.throws(
      function () {
        svc.startDownload(2);
      },
      /API token/i
    );

    await svc.importCsvText("2", FIXTURE_CSV, {
      name: "us-northeast",
      human: "US Northeast",
      created: 1000,
      size: 100,
    });
    assert.strictEqual(svc.isIndexReady(), true);

    const hits = svc.search("600 Market", {
      limit: 5,
      nearLat: 35.0456,
      nearLon: -85.3097,
    });
    assert.ok(hits.length >= 1);
    assert.ok(/600 Market/i.test(hits[0].label));
    assert.ok(Math.abs(hits[0].lat - 35.0456) < 0.001);

    const nearChat = svc.search("Broadway", {
      limit: 5,
      nearLat: 35.0456,
      nearLon: -85.3097,
    });
    const nearNash = svc.search("Broadway", {
      limit: 5,
      nearLat: 36.1627,
      nearLon: -86.7816,
    });
    assert.ok(nearChat.length >= 1);
    assert.ok(nearNash.length >= 1);
    assert.ok(/Nashville/i.test(nearNash[0].label));

    const readyStatus = await svc.getStatus({ forceCatalog: true });
    assert.strictEqual(readyStatus.indexReady, true);
    assert.strictEqual(readyStatus.collections[0].status, "update_available");
    assert.strictEqual(readyStatus.collections[0].installed, true);

    catalog[0].created = 1000;
    catalog[0].size = 100;
    const current = await svc.getStatus({ forceCatalog: true });
    assert.strictEqual(current.collections[0].status, "ready");
  } finally {
    try {
      svc.close();
    } catch (_) {
      /* ignore */
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log("openaddresses.test.js: all assertions passed");
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
