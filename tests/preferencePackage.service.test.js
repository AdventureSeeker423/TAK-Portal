const assert = require("assert");
const unzipper = require("unzipper");
const {
  buildPreferencePackageZip,
  buildConfigPrefXml,
  validatePreferenceInputs,
  buildPreferencePackageFilename,
  buildTeamSelectOptions,
  buildRoleSelectOptions,
} = require("../services/preferencePackage.service");

async function unzipBuffer(buffer) {
  const entries = new Map();
  const directory = await unzipper.Open.buffer(buffer);
  for (const entry of directory.files) {
    entries.set(entry.path, await entry.buffer());
  }
  return entries;
}

(async function run() {
  const normalized = validatePreferenceInputs({
    callsign: "ANDROID-JUSTIN",
    teamLabel: "Dark Green",
    roleLabel: "Team Member",
  });
  assert.strictEqual(normalized.callsign, "ANDROID-JUSTIN");
  assert.strictEqual(normalized.teamLabel, "Dark Green");
  assert.strictEqual(normalized.roleLabel, "Team Member");

  assert.throws(() => validatePreferenceInputs({ callsign: "" }), /Callsign is required/);
  assert.throws(
    () => validatePreferenceInputs({ callsign: "X", teamLabel: "Not A Color" }),
    /Invalid team color/
  );

  const prefXml = buildConfigPrefXml([
    { key: "locationCallsign", value: "ANDROID-JUSTIN" },
    { key: "locationTeam", value: "Dark Green" },
    { key: "atakRoleType", value: "Team Member" },
  ]);
  assert.ok(prefXml.includes('name="com.atakmap.app_civ_preferences"'));
  assert.ok(prefXml.includes('name="com.atakmap.app_preferences"'));
  assert.ok(prefXml.includes("ANDROID-JUSTIN"));
  assert.ok(prefXml.includes("Dark Green"));
  assert.ok(prefXml.includes("Team Member"));

  const filename = buildPreferencePackageFilename({
    callsign: "ANDROID-JUSTIN",
    teamLabel: "Dark Green",
    roleLabel: "Team Member",
  });
  assert.ok(filename.endsWith(".zip"));
  assert.ok(filename.includes("ANDROID-JUSTIN"));

  const built = await buildPreferencePackageZip({
    callsign: "ANDROID-JUSTIN",
    teamLabel: "Dark Green",
    roleLabel: "Team Member",
  });
  assert.ok(Buffer.isBuffer(built.buffer));
  assert.ok(built.buffer.length > 100);
  assert.strictEqual(built.packageName, filename);
  assert.match(built.hash, /^[a-f0-9]{64}$/);

  const teamOptions = buildTeamSelectOptions({ DP_COLOR_DARK_BLUE: "Law Enforcement" });
  const darkBlue = teamOptions.find((o) => o.value === "Dark Blue");
  assert.ok(darkBlue);
  assert.strictEqual(darkBlue.label, "Dark Blue -- Law Enforcement");

  const roleOptions = buildRoleSelectOptions({ DP_ROLE_HQ: "Command Staff / Admin Support" });
  const hq = roleOptions.find((o) => o.value === "HQ");
  assert.ok(hq);
  assert.strictEqual(hq.label, "HQ -- Command Staff / Admin Support");

  const entries = await unzipBuffer(built.buffer);
  assert.ok(entries.has("MANIFEST/manifest.xml"));
  assert.ok(entries.has("certs/config.pref"));

  const manifest = entries.get("MANIFEST/manifest.xml").toString("utf8");
  assert.ok(manifest.includes('<MissionPackageManifest version="2">'));
  assert.ok(manifest.includes('zipEntry="certs/config.pref"'));
  assert.ok(manifest.includes('onReceiveImport" value="true"'));

  const configPref = entries.get("certs/config.pref").toString("utf8");
  assert.ok(configPref.includes("locationCallsign"));
  assert.ok(configPref.includes("locationTeam"));
  assert.ok(configPref.includes("atakRoleType"));

  console.log("preferencePackage.service.test.js OK");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
