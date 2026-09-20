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
  takMetricsSrc.includes("/api/clientEndPoints"),
  "dashboard Marti pull must use currently-connected clientEndPoints as membership"
);
assert.ok(
  takMetricsSrc.includes("showCurrentlyConnectedClients"),
  "clientEndPoints fetch must request currently connected clients only"
);

const directoryRepoSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "directoryRepo.service.js"),
  "utf8"
);
const callsignKeysFn = directoryRepoSrc.slice(
  directoryRepoSrc.indexOf("async function getUsersByCallsignKeys"),
  directoryRepoSrc.indexOf("async function getUserById")
);
assert.ok(
  !/lower\(name\) = ANY/.test(callsignKeysFn),
  "portal username lookup must not match display name"
);

const {
  parseTakvFields,
  normalizeConnectedClientRow,
  slimSubscriptionsForClientList,
  mergeClientEndpointUsernames,
  filterConnectedUserSubscriptions,
  isEmptyConnectedClient,
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

const uidOnly = normalizeConnectedClientRow({ uid: "live-uid", team: "Cyan" });
assert.ok(uidOnly, "live endpoint rows with a uid must be kept for membership");
assert.strictEqual(uidOnly.uid, "live-uid");
assert.strictEqual(uidOnly.username, "");
assert.ok(isEmptyConnectedClient(uidOnly));

const dashPlaceholder = normalizeConnectedClientRow({
  uid: "ghost",
  callsign: "—",
  username: "—",
  role: "—",
});
assert.ok(dashPlaceholder, "dash placeholders with a uid stay in the live set");
assert.strictEqual(dashPlaceholder.username, "");
assert.strictEqual(dashPlaceholder.callsign, "");
assert.ok(isEmptyConnectedClient(dashPlaceholder));

assert.strictEqual(
  normalizeConnectedClientRow({ team: "Cyan", role: "HQ" }),
  null,
  "rows with no uid, callsign, or username must be dropped"
);
assert.ok(isEmptyConnectedClient({ callsign: "", username: "", takClient: "ATAK-CIV" }));
assert.ok(isEmptyConnectedClient({ callsign: "—", username: "-", role: "HQ" }));

const merged = mergeClientEndpointUsernames(
  [{ uid: "device-1", callsign: "HCSO-DAVIS-3598", team: "Cyan", role: "HQ" }],
  [{ uid: "device-1", callsign: "HCSO-DAVIS-3598", username: "davis.hcso" }]
);
assert.strictEqual(merged[0].username, "davis.hcso");
assert.strictEqual(merged[0].team, "Cyan");
assert.strictEqual(merged[0].role, "HQ");

const mergedAlt = mergeClientEndpointUsernames(
  [{ uid: "device-2", callsign: "HCSO-2", team: "Cyan" }],
  [{ uid: "device-2", callsign: "HCSO-2", userName: "alt.hcso" }]
);
assert.strictEqual(mergedAlt[0].username, "alt.hcso");

const liveWithIntegration = mergeClientEndpointUsernames(
  [
    { uid: "device-1", callsign: "A", team: "Cyan", role: "Team Member" },
    { uid: "stale-contact", callsign: "OLD", username: "stale.hcso", team: "Red" },
  ],
  [
    { uid: "device-1", callsign: "A", username: "alice.hcso" },
    { uid: "nodered-1", username: "nodered-weather", callsign: "WX" },
  ]
);
assert.strictEqual(liveWithIntegration.length, 2, "contacts-only rows must not become connected");
assert.ok(liveWithIntegration.some((row) => row.username === "nodered-weather"));
assert.ok(!liveWithIntegration.some((row) => row.uid === "stale-contact"));
const enrichedHuman = liveWithIntegration.find((row) => row.uid === "device-1");
assert.strictEqual(enrichedHuman.team, "Cyan");
assert.strictEqual(enrichedHuman.role, "Team Member");

const zeroConnected = mergeClientEndpointUsernames(
  [{ uid: "stale-contact", username: "stale.hcso" }],
  []
);
assert.strictEqual(
  zeroConnected.length,
  0,
  "empty currently-connected endpoints must not fall back to contacts"
);

const endpointsFailed = mergeClientEndpointUsernames(
  [{ uid: "fallback", username: "fallback.hcso" }],
  null
);
assert.strictEqual(endpointsFailed.length, 1);
assert.strictEqual(endpointsFailed[0].username, "fallback.hcso");

const filtered = filterConnectedUserSubscriptions([
  { username: "alice", callsign: "A1" },
  { uid: "ghost", team: "Cyan" },
  { callsign: "—", username: "", takClient: "—" },
  { username: "nodered-bridge", callsign: "NR1" },
]);
assert.strictEqual(filtered.length, 1);
assert.strictEqual(filtered[0].username, "alice");

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

const nestedNodered = applySubscriptionMetricsSplit(
  { connectedClients: 2 },
  {
    data: [
      { uid: "nr1", user: { name: "nodered-wx" } },
      { uid: "u1", username: "alice.hcso" },
    ],
  }
);
assert.strictEqual(nestedNodered.connectedClients, 1);
assert.strictEqual(nestedNodered.connectedIntegrations, 1);

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
      { uid: "ghost", team: "Cyan" },
      { callsign: "—", username: "—", takClient: "—", role: "—" },
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

    const slim = slimSubscriptionsForClientList([alice]);
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
