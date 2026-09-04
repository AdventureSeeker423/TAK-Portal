const assert = require("assert");
const {
  metricsFromPayload,
  viewFields,
} = require("../services/takDashboardCache.service");

const base = {
  connectedClients: 10,
  uptimeSeconds: 3661,
  diskUsagePercent: 12.4,
};
const subscriptions = {
  configured: true,
  data: [{ username: "nodered-bridge" }, { username: "alice.agency" }],
};

const global = metricsFromPayload({ metricsBase: base, subscriptions });
assert.strictEqual(global.connectedClients, 9);
assert.strictEqual(global.connectedIntegrations, 1);

const again = metricsFromPayload({ metricsBase: base, subscriptions });
assert.strictEqual(again.connectedClients, 9);

const legacy = metricsFromPayload({
  connectedClients: 4,
  uptimeSeconds: 90,
  diskUsagePercent: 3.0,
});
assert.strictEqual(legacy.connectedClients, 4);
assert.strictEqual(viewFields(legacy).uptime, "1m");
assert.strictEqual(viewFields(legacy).disk, "3");
assert.strictEqual(viewFields(global).uptime, "1h 1m");
assert.strictEqual(viewFields(global).disk, "12");
assert.strictEqual(viewFields(null).connectedClients, "--");

assert.strictEqual(metricsFromPayload({}), null);
assert.strictEqual(metricsFromPayload(null), null);

console.log("takDashboardCache.test.js: ok");
