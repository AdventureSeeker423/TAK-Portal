const assert = require("assert");
const unzipper = require("unzipper");
const {
  buildEnrollmentConfigPrefXml,
  buildEnrollmentManifestXml,
  buildEnrollmentPackageFilename,
  buildEnrollmentPackageZip,
} = require("../services/enrollmentPackage.service");

async function unzipBuffer(buffer) {
  const entries = new Map();
  const directory = await unzipper.Open.buffer(buffer);
  for (const entry of directory.files) {
    entries.set(entry.path, await entry.buffer());
  }
  return entries;
}

(async function run() {
  assert.strictEqual(
    buildEnrollmentPackageFilename({ callsign: "ALPHA-1", username: "jdoe" }),
    "ALPHA-1-TAK-DataPackage.zip"
  );
  assert.strictEqual(
    buildEnrollmentPackageFilename({ callsign: "", username: "jdoe" }),
    "jdoe-TAK-DataPackage.zip"
  );

  const prefXml = buildEnrollmentConfigPrefXml({
    host: "tak.example.gov",
    description: "Demo TAK",
    caPassword: "atakatak",
    callsign: "ALPHA-1",
    teamLabel: "Green",
    roleLabel: "Team Lead",
  });
  assert.ok(prefXml.includes('name="cot_streams"'));
  assert.ok(prefXml.includes("tak.example.gov:8089:ssl"));
  assert.ok(prefXml.includes("enrollForCertificateWithTrust0"));
  assert.ok(prefXml.includes("useAuth0"));
  assert.ok(prefXml.includes("Cache credentials"));
  assert.ok(prefXml.includes("cert/caCert.p12"));
  assert.ok(prefXml.includes("atakatak"));
  assert.ok(prefXml.includes("ALPHA-1"));
  assert.ok(prefXml.includes("Green"));
  assert.ok(prefXml.includes("Team Lead"));
  assert.ok(prefXml.includes('name="com.atakmap.app_preferences"'));
  assert.ok(prefXml.includes('name="com.atakmap.app_civ_preferences"'));

  const manifest = buildEnrollmentManifestXml({
    packageName: "ALPHA-1-TAK-DataPackage.zip",
    uid: "11111111-1111-1111-1111-111111111111",
  });
  assert.ok(manifest.includes('<MissionPackageManifest version="2">'));
  assert.ok(manifest.includes('zipEntry="certs/config.pref"'));
  assert.ok(manifest.includes('zipEntry="certs/caCert.p12"'));
  assert.ok(manifest.includes('onReceiveDelete" value="true"'));

  const fakeP12 = Buffer.from("not-a-real-p12-but-fine-for-zip-test");
  const built = await buildEnrollmentPackageZip({
    username: "jdoe",
    callsign: "ALPHA-1",
    teamLabel: "Green",
    roleLabel: "Team Lead",
    caP12: fakeP12,
    caPassword: "atakatak",
    host: "tak.example.gov",
    description: "Demo TAK",
  });
  assert.ok(Buffer.isBuffer(built.buffer));
  assert.ok(built.buffer.length > 100);
  assert.strictEqual(built.packageName, "ALPHA-1-TAK-DataPackage.zip");
  assert.match(built.hash, /^[a-f0-9]{64}$/);

  const entries = await unzipBuffer(built.buffer);
  assert.ok(entries.has("MANIFEST/manifest.xml"));
  assert.ok(entries.has("certs/config.pref"));
  assert.ok(entries.has("certs/caCert.p12"));
  assert.ok(entries.get("certs/caCert.p12").equals(fakeP12));

  const configPref = entries.get("certs/config.pref").toString("utf8");
  assert.ok(configPref.includes("enrollForCertificateWithTrust0"));
  assert.ok(configPref.includes("locationCallsign"));
  assert.ok(configPref.includes("ALPHA-1"));

  console.log("enrollmentPackage.service.test.js OK");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
