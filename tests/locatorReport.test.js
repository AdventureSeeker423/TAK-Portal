const assert = require("assert");
const report = require("../services/locatorReport.service");

assert.ok(Math.abs(report.haversineMeters(
  { latitude: 35.0, longitude: -85.0 },
  { latitude: 35.0, longitude: -85.0 }
)) < 0.01);

const about111km = report.haversineMeters(
  { latitude: 0, longitude: 0 },
  { latitude: 1, longitude: 0 }
);
assert.ok(about111km > 110000 && about111km < 112000);

const history = [
  {
    at: "2026-09-06T16:00:00.000Z",
    latitude: 35.04,
    longitude: -85.31,
    accuracyMeters: 12,
    kind: "interval",
    callsign: "Doe, Jane",
    answers: { f1: "Jane", f2: "Doe" },
  },
  {
    at: "2026-09-06T16:05:00.000Z",
    latitude: 35.041,
    longitude: -85.31,
    accuracyMeters: 8,
    kind: "interval",
    remarks: "On the trail",
  },
];

const stats = report.summarizeTrack(history);
assert.strictEqual(stats.fixCount, 2);
assert.strictEqual(stats.pingCount, 2);
assert.ok(stats.distanceMeters > 50);
assert.strictEqual(stats.durationMs, 5 * 60 * 1000);
assert.strictEqual(stats.bestAccuracyMeters, 8);
assert.strictEqual(report.formatDistance(250), "250 m");
assert.strictEqual(report.formatDuration(5 * 60 * 1000), "5m 0s");
assert.strictEqual(report.locatorStatusLabel({ archived: true }), "Archived");
assert.strictEqual(report.intervalLabel(0), "One-time");
assert.strictEqual(report.intervalLabel(15), "15 seconds");

const form = {
  heading: "Share Location",
  intro: "Please share",
  fields: [
    { id: "f1", type: "firstName", label: "First Name", required: true },
    { id: "f2", type: "lastName", label: "Last Name", required: true },
    { id: "f3", type: "text", label: "Unit", required: false },
  ],
};
const collected = report.collectFormAnswers(form, history);
assert.strictEqual(collected.find((a) => a.label === "First Name").value, "Jane");
assert.strictEqual(collected.find((a) => a.label === "Last Name").value, "Doe");
assert.strictEqual(collected.find((a) => a.label === "Unit").value, "");

assert.strictEqual(report.pinStyleForIndex(0, 4).hex, "#15803d");
assert.strictEqual(report.pinStyleForIndex(1, 4).hex, "#94a3b8");
assert.strictEqual(report.pinStyleForIndex(3, 4).hex, "#dc2626");
assert.strictEqual(report.pinStyleForIndex(0, 1).hex, "#dc2626");

const generatedAt = new Date("2026-09-06T21:00:00.000Z");
assert.strictEqual(
  report.reportFileName({ slug: "missing-person" }, generatedAt),
  "locate-report-missing-person-2026-09-06-21-00-00.pdf"
);

assert.ok(report.formatReportWhen("2026-09-06T21:00:00.000Z").includes("UTC"));
assert.ok(report.formatLogWhen("2026-09-06T21:00:00.000Z").includes("UTC"));

const view = report.fitMapView(history);
assert.ok(view);
assert.ok(view.zoom >= 3 && view.zoom <= 16);

async function main() {
  const pdf = await report.generateLocatorReportPdf(
    {
      id: "loc1",
      slug: "missing-person",
      title: "Missing Person",
      channel: "HCSO Main",
      channelDisplay: "HCSO Main",
      mission: "Search Alpha",
      dropPoints: true,
      color: "Cyan",
      pingIntervalSeconds: 15,
      active: true,
      archived: false,
      createdAt: "2026-09-06T15:00:00.000Z",
      updatedAt: "2026-09-06T16:05:00.000Z",
      form,
    },
    history,
    {
      generatedAt,
      serverName: "Test TAK",
      logoPath: "",
      includeMap: false,
    }
  );
  assert.ok(Buffer.isBuffer(pdf.buffer));
  assert.ok(pdf.buffer.slice(0, 4).toString() === "%PDF");
  assert.ok(pdf.buffer.length > 500);
  assert.strictEqual(pdf.fileName, "locate-report-missing-person-2026-09-06-21-00-00.pdf");
  const pageCount = (pdf.buffer.toString("latin1").match(/\/Type\s*\/Page(?!s)/g) || []).length;
  assert.strictEqual(pageCount, 2);
  console.log("locatorReport.test.js: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
