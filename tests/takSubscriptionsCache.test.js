const assert = require("assert");
const fs = require("fs");
const path = require("path");

const dashSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "takDashboardCache.service.js"),
  "utf8"
);
assert.ok(
  /getSubscriptionsAll\(\{\s*live:\s*true/.test(dashSrc),
  "worker TAK dashboard refresh must live-fetch subscriptions"
);
assert.ok(
  /keepFull:\s*false/.test(dashSrc),
  "worker must not retain Marti group vectors after slimming"
);

const takMetricsSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "takMetrics.service.js"),
  "utf8"
);
assert.ok(
  takMetricsSrc.includes("/api/subscriptions/all"),
  "dashboard Marti pull must use /api/subscriptions/all as membership"
);
assert.ok(
  takMetricsSrc.includes("gzip"),
  "Marti subscription fetch should request gzip to shrink group-vector payloads"
);
assert.ok(
  !takMetricsSrc.includes("/api/clientEndPoints"),
  "dashboard count path must not use clientEndPoints as membership"
);
assert.ok(
  !takMetricsSrc.includes("/api/contacts/all/lite"),
  "dashboard count path must not use contacts lite as membership"
);

const {
  parseTakvFields,
  normalizeConnectedClientRow,
  slimSubscriptionsForClientList,
  filterConnectedUserSubscriptions,
  filterFederationSubscriptions,
  getSubscriptionsAll,
  applySubscriptionMetricsSplit,
} = require("../services/takMetrics.service");

assert.deepStrictEqual(parseTakvFields("ATAK-CIV-5.4.0 (abc)"), {
  takClient: "ATAK-CIV",
  version: "5.4.0 (abc)",
});
assert.deepStrictEqual(parseTakvFields("TAKAware-CIV:5.2.0"), {
  takClient: "TAKAware-CIV",
  version: "5.2.0",
});
assert.deepStrictEqual(parseTakvFields("TAKAware-CIV:"), {
  takClient: "TAKAware-CIV",
  version: "",
});
assert.deepStrictEqual(parseTakvFields({ platform: "iTAK", version: "2.9.1" }), {
  takClient: "iTAK",
  version: "2.9.1",
});

const slimRow = normalizeConnectedClientRow({
  uid: "device-1",
  username: "jsmith.hcso",
  callsign: "HCSO-1",
  team: "Cyan",
  role: "Team Member",
  takv: "ATAK-CIV-5.4.0",
  groups: [{ name: "TAK_SHOULD_DROP" }],
});
assert.strictEqual(slimRow.username, "jsmith.hcso");
assert.strictEqual(slimRow.callsign, "HCSO-1");
assert.strictEqual(slimRow.takClient, "ATAK-CIV");
assert.strictEqual(slimRow.version, "5.4.0");
assert.strictEqual(slimRow.clientUid, "device-1");
assert.strictEqual(slimRow.groups, undefined);
assert.strictEqual(slimRow.takv, undefined, "slim rows must drop Marti takv payloads");

assert.strictEqual(
  normalizeConnectedClientRow({
    uid: "nr1",
    user: { name: "nodered-wx" },
    callsign: "WX",
  }).username,
  "",
  "2.0.5 classification uses item.username only, not nested user.name"
);

const filtered = filterConnectedUserSubscriptions([
  { username: "alice", callsign: "A1" },
  { username: "nodered-bridge", callsign: "NR1" },
  { username: "aa:bb:cc:dd:ee:ff", callsign: "FED" },
  { username: "bob", callsign: "tls:24" },
  { username: "portal", callsign: "tak-portal" },
]);
assert.strictEqual(filtered.length, 1);
assert.strictEqual(filtered[0].username, "alice");

const keptNodered = filterFederationSubscriptions([
  { username: "alice", callsign: "A1" },
  { username: "nodered-weather", callsign: "WX" },
  { username: "aa:bb:cc:dd:ee:ff", callsign: "FED" },
]);
assert.strictEqual(keptNodered.length, 2);
assert.ok(keptNodered.some((row) => row.username === "nodered-weather"));

const humans = Array.from({ length: 1000 }, (_, i) => ({
  uid: `user-${i}`,
  username: `user${i}.hcso`,
  callsign: `CS-${i}`,
}));
const integrations = Array.from({ length: 70 }, (_, i) => ({
  uid: `nodered-${i}`,
  username: `nodered-feed-${i}`,
  callsign: `NR-${i}`,
}));
const split = applySubscriptionMetricsSplit(
  { connectedClients: 1070 },
  { data: humans.concat(integrations) }
);
assert.strictEqual(split.connectedClients, 1000);
assert.strictEqual(split.connectedIntegrations, 70);

const splitDup = applySubscriptionMetricsSplit(
  { connectedClients: 1071 },
  {
    data: humans.concat(integrations).concat([
      { uid: "nodered-0-dup", username: "nodered-feed-0", callsign: "NR-0b" },
    ]),
  }
);
assert.strictEqual(splitDup.connectedClients, 1000, "duplicate nodered sessions still subtract from users");
assert.strictEqual(splitDup.connectedIntegrations, 70, "duplicate nodered sessions do not inflate integrations");

const splitExtras = applySubscriptionMetricsSplit(
  { connectedClients: 5 },
  {
    data: [
      { username: "alice", callsign: "A1" },
      { username: "nodered-wx", callsign: "WX" },
      { username: "aa:bb:cc:dd:ee:ff", callsign: "FED" },
      { username: "bob", callsign: "tls:24" },
      { username: "carol", callsign: "C1" },
    ],
  }
);
assert.strictEqual(splitExtras.connectedClients, 2);
assert.strictEqual(splitExtras.connectedIntegrations, 1);

const listAheadOfNumClients = applySubscriptionMetricsSplit(
  { connectedClients: 2 },
  {
    data: [
      { username: "alice", callsign: "A1" },
      { username: "bob", callsign: "B1" },
      { username: "carol", callsign: "C1" },
    ],
  }
);
assert.strictEqual(
  listAheadOfNumClients.connectedClients,
  3,
  "human subscription list must not undercount vs a lagging numClients"
);

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
      { uid: "nodered-1", username: "nodered-weather", callsign: "WX" },
    ],
  },
});

(async () => {
  try {
    const cached = await getSubscriptionsAll();
    const alice = cached.data.find((row) => row.username === "alice");
    assert.ok(alice, "web reads the worker snapshot instead of waiting on live TAK");
    assert.ok(
      cached.data.some((row) => row.username === "nodered-weather"),
      "nodered rows stay in the membership list for integrations"
    );

    const humanList = filterConnectedUserSubscriptions(cached.data);
    assert.strictEqual(humanList.length, 1);
    assert.strictEqual(humanList[0].username, "alice");

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
