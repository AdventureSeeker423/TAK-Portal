const assert = require("assert");
const fs = require("fs");
const path = require("path");

const dashSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "takDashboardCache.service.js"),
  "utf8"
);
assert.ok(
  /getSubscriptionsAll\(\{\s*live:\s*true\s*\}/.test(dashSrc),
  "worker TAK dashboard refresh must live-fetch subscriptions"
);

const takMetricsSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "takMetrics.service.js"),
  "utf8"
);
assert.ok(
  takMetricsSrc.includes("/api/contacts/all/lite"),
  "dashboard Marti pull must prefer contacts lite over subscriptions/all"
);

const {
  parseTakvFields,
  normalizeConnectedClientRow,
  slimSubscriptionsForClientList,
  getSubscriptionsAll,
} = require("../services/takMetrics.service");

assert.deepStrictEqual(parseTakvFields("ATAK-CIV-5.4.0 (abc)"), {
  takClient: "ATAK-CIV",
  version: "5.4.0 (abc)",
});
assert.deepStrictEqual(parseTakvFields({ platform: "iTAK", version: "2.9.1" }), {
  takClient: "iTAK",
  version: "2.9.1",
});

const liteRow = normalizeConnectedClientRow({
  uid: "device-1",
  callsign: "HCSO-1",
  team: "Cyan",
  role: "Team Member",
  takv: "ATAK-CIV-5.4.0",
  user: { name: "jsmith.hcso" },
  groups: [{ name: "TAK_SHOULD_DROP" }],
});
assert.strictEqual(liteRow.username, "jsmith.hcso");
assert.strictEqual(liteRow.takClient, "ATAK-CIV");
assert.strictEqual(liteRow.version, "5.4.0");
assert.strictEqual(liteRow.clientUid, "device-1");
assert.strictEqual(liteRow.groups, undefined);

const dash = require("../services/takDashboardCache.service");

const origSnapshot = dash.getDashboardTakSnapshot;
dash.getDashboardTakSnapshot = async () => ({
  subscriptions: {
    configured: true,
    data: [
      {
        username: "alice",
        callsign: "A1",
        groups: [{ name: "should-not-be-sent-to-browser" }],
      },
    ],
  },
});

(async () => {
  try {
    const cached = await getSubscriptionsAll();
    assert.strictEqual(
      cached.data[0].username,
      "alice",
      "web reads the worker snapshot instead of waiting on live TAK"
    );

    const slim = slimSubscriptionsForClientList(cached.data);
    assert.strictEqual(slim[0].username, "alice");
    assert.strictEqual(slim[0].callsign, "A1");
    assert.strictEqual(
      slim[0].groups,
      undefined,
      "client list response must drop Marti group payloads"
    );

    console.log("takSubscriptionsCache.test.js: ok");
  } finally {
    dash.getDashboardTakSnapshot = origSnapshot;
  }
})().catch((err) => {
  dash.getDashboardTakSnapshot = origSnapshot;
  console.error(err);
  process.exit(1);
});
