#!/usr/bin/env node
/**
 * Audit bundled map iconsets: XML/PNG integrity + resolveIcon coverage matrix.
 */
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const mapIcon = require("../services/mapIcon.service");
const mapRender = require("../services/mapRender.service");

const REPORT_DIR = path.join(__dirname, "..", "reports");

const REQUIRED_FIXTURES = [
  {
    name: "ADSB civilian fixed-wing",
    type: "a-f-A-C-F",
    affiliation: "friend",
    origin: "feed",
    expectIconFragment: "Plane",
    expectUsesMapIcon: true,
  },
  {
    name: "ADSB civilian rotor",
    type: "a-f-A-C-H",
    affiliation: "friend",
    origin: "feed",
    expectIconFragment: "Helicopter",
    expectUsesMapIcon: true,
  },
  {
    name: "ADSB civilian LTA",
    type: "a-f-A-C-L",
    affiliation: "friend",
    origin: "feed",
    expectIconFragment: "Balloon",
    expectUsesMapIcon: true,
  },
  {
    name: "Military fixed-wing",
    type: "a-f-A-M-F",
    affiliation: "friend",
    origin: "feed",
    expectIconFragment: "a-f-A-M-F",
    expectUsesMapIcon: true,
  },
  {
    name: "Military rotor",
    type: "a-f-A-M-H",
    affiliation: "friend",
    origin: "feed",
    expectIconFragment: "a-f-A-M-H",
    expectUsesMapIcon: true,
  },
  {
    name: "EUD air — team dot only",
    type: "a-f-A-C-H",
    affiliation: "friend",
    origin: "eud",
    expectUsesMapIcon: false,
  },
  {
    name: "EUD ground — team dot only",
    type: "a-f-G-U-C",
    affiliation: "friend",
    origin: "eud",
    expectUsesMapIcon: false,
  },
  {
    name: "Feed ground vehicle",
    type: "a-f-G-E-V",
    affiliation: "friend",
    origin: "feed",
    expectUsesMapIcon: true,
  },
  {
    name: "COT_MAPPING_2525B path override",
    type: "a-f-G-E-V",
    affiliation: "friend",
    origin: "feed",
    usericon: { iconsetpath: "COT_MAPPING_2525B/a/f/A/C/H" },
    expectUsesMapIcon: true,
    expectIconFragment: "Helicopter",
  },
];

const AFFILIATIONS = ["f", "h", "n", "u"];
const AIR_DIMENSIONS = ["C", "M"];
const AIR_ROLES = ["F", "H", "L", "Q", "R", "U"];

function generateAirTypeMatrix() {
  const out = [];
  for (const aff of AFFILIATIONS) {
    for (const dim of AIR_DIMENSIONS) {
      for (const role of AIR_ROLES) {
        out.push(`a-${aff}-A-${dim}-${role}`);
      }
    }
  }
  return out;
}

async function auditIconsetXmlPng(iconset) {
  const issues = [];
  for (const icon of iconset.icons) {
    const relPath = resolveRelForAudit(iconset, icon);
    if (!relPath) {
      issues.push({
        severity: "error",
        kind: "missing_png",
        iconset: iconset.dirName,
        iconName: icon.name,
        type2525b: icon.type2525b || null,
      });
    }
  }
  return issues;
}

function resolveRelForAudit(iconset, icon) {
  const base = String(icon.name || "").trim();
  if (!base) return null;
  const fromIndex = iconset.fileByBase.get(base.toLowerCase());
  if (fromIndex) return fromIndex;
  const group = String(icon.group || iconset.defaultGroup || "").trim();
  if (group) {
    const candidate = `${group}/${base}`.replace(/\\/g, "/");
    const abs = path.join(iconset.rootDir, candidate);
    if (fs.existsSync(abs)) return candidate;
  }
  for (const rel of iconset.fileByBase.values()) {
    if (rel.toLowerCase().endsWith("/" + base.toLowerCase())) return rel;
  }
  return null;
}

async function loadIconsetsForAudit() {
  await mapIcon.ensureIconsets();
  const status = mapIcon.getStatus();
  if (!status.ready) {
    throw new Error("Iconsets failed to load from " + mapIcon.DATA_ROOT);
  }
  if (status.iconsetCount < status.requiredIconsetCount) {
    throw new Error(
      `Only ${status.iconsetCount}/${status.requiredIconsetCount} iconsets loaded`
    );
  }
}

function auditAliases() {
  const issues = [];
  for (const [key, alias] of mapIcon.ICON_PATH_ALIASES) {
    const hit = mapIcon.resolveIcon({
      type: "a-f-G-E-V",
      affiliation: "friend",
      usericon: {
        iconsetpath: `${alias.iconsetUid}/${alias.relPath}`,
        name: path.basename(alias.relPath),
      },
    });
    const file = hit?.iconId ? mapIcon.getIconFilePath(hit.iconId) : null;
    if (!file) {
      issues.push({
        severity: "error",
        kind: "broken_alias",
        key,
        alias,
      });
    }
  }
  return issues;
}

function runResolutionMatrix(types) {
  const results = [];
  const unresolved = [];
  for (const type of types) {
    const resolved = mapIcon.resolveIcon({ type, affiliation: "friend" });
    if (!resolved) {
      unresolved.push(type);
    }
    results.push({
      type,
      resolved: resolved
        ? {
            iconId: resolved.iconId,
            source: resolved.source,
            fileExists: !!mapIcon.getIconFilePath(resolved.iconId),
          }
        : null,
    });
  }
  return { results, unresolved };
}

function runFixtures(fixtures) {
  const failures = [];
  for (const fx of fixtures) {
    const resolved = mapIcon.resolveIcon({
      type: fx.type,
      affiliation: fx.affiliation || "friend",
      usericon: fx.usericon,
    });
    const marker = {
      type: fx.type,
      affiliation: fx.affiliation || "friend",
      origin: fx.origin || "feed",
      iconId: resolved?.iconId || null,
      iconSource: resolved?.source || null,
    };
    const usesIcon = mapRender.markerUsesMapIcon(marker);

    if (fx.expectUsesMapIcon !== undefined && usesIcon !== fx.expectUsesMapIcon) {
      failures.push({
        fixture: fx.name,
        kind: "display_gate",
        expected: fx.expectUsesMapIcon,
        actual: usesIcon,
        marker,
      });
    }

    if (!resolved) {
      failures.push({ fixture: fx.name, kind: "unresolved" });
      continue;
    }

    if (!mapIcon.getIconFilePath(resolved.iconId)) {
      failures.push({
        fixture: fx.name,
        kind: "missing_file",
        iconId: resolved.iconId,
      });
    }

    if (fx.expectIconFragment) {
      const id = String(resolved.iconId || "").toUpperCase();
      const rel = String(resolved.relPath || resolved.iconId || "").toUpperCase();
      const frag = fx.expectIconFragment.toUpperCase();
      if (!id.includes(frag) && !rel.includes(frag)) {
        failures.push({
          fixture: fx.name,
          kind: "wrong_icon",
          expectedFragment: fx.expectIconFragment,
          iconId: resolved.iconId,
          relPath: resolved.relPath,
        });
      }
    }
  }
  return failures;
}

async function buildInternalIconsetInventory() {
  const internalSets = [];
  for (const dirName of mapIcon.REQUIRED_ICONSET_DIRS) {
    const rootDir = path.join(mapIcon.DATA_ROOT, dirName);
    const xmlPath = path.join(rootDir, "iconset.xml");
    if (!fs.existsSync(xmlPath)) continue;
    const xml = await fsp.readFile(xmlPath, "utf8");
    const fileByBase = new Map();
    async function walk(dir) {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (/\.png$/i.test(entry.name)) {
          const rel = path.relative(rootDir, full).replace(/\\/g, "/");
          fileByBase.set(path.basename(rel).toLowerCase(), rel);
        }
      }
    }
    await walk(rootDir);
    const icons = [];
    for (const m of xml.matchAll(/<icon\s+([^>]+?)\/?>/gi)) {
      const attrs = m[1];
      const nameM = attrs.match(/name="([^"]*)"/i);
      const typeM = attrs.match(/type2525b="([^"]*)"/i);
      const groupM = attrs.match(/group="([^"]*)"/i);
      icons.push({
        name: nameM ? nameM[1] : "",
        type2525b: typeM ? typeM[1] : "",
        group: groupM ? groupM[1] : "",
      });
    }
    const defaultGroupM = xml.match(/defaultGroup="([^"]*)"/i);
    internalSets.push({
      dirName,
      rootDir,
      defaultGroup: defaultGroupM ? defaultGroupM[1] : "",
      icons,
      fileByBase,
    });
  }
  return internalSets;
}

async function main() {
  await loadIconsetsForAudit();

  const internalSets = await buildInternalIconsetInventory();
  const xmlIssues = [];
  for (const set of internalSets) {
    xmlIssues.push(...(await auditIconsetXmlPng(set)));
  }

  const aliasIssues = auditAliases();

  const allTypes = new Set();
  for (const row of mapIcon.getTypeIndexSnapshot()) {
    allTypes.add(row.type2525b);
  }
  for (const t of generateAirTypeMatrix()) allTypes.add(t.toLowerCase());

  const matrix = runResolutionMatrix([...allTypes].sort());
  const fixtureFailures = runFixtures(REQUIRED_FIXTURES);

  const report = {
    auditedAt: new Date().toISOString(),
    status: mapIcon.getStatus(),
    iconsets: mapIcon.listIconsets(),
    xmlIssues,
    aliasIssues,
    matrix: {
      total: matrix.results.length,
      resolved: matrix.results.filter((r) => r.resolved).length,
      unresolved: matrix.unresolved,
      missingFiles: matrix.results.filter((r) => r.resolved && !r.resolved.fileExists),
    },
    fixtureFailures,
    ok:
      xmlIssues.length === 0 &&
      aliasIssues.length === 0 &&
      matrix.unresolved.length === 0 &&
      matrix.results.every((r) => !r.resolved || r.resolved.fileExists) &&
      fixtureFailures.length === 0,
  };

  await fsp.mkdir(REPORT_DIR, { recursive: true });
  const outPath = path.join(REPORT_DIR, "icon-audit.json");
  await fsp.writeFile(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log("Map icon audit");
  console.log("  Iconsets:", report.status.iconsetCount);
  console.log("  Type mappings:", report.status.typeMappings);
  console.log("  XML/PNG issues:", xmlIssues.length);
  console.log("  Alias issues:", aliasIssues.length);
  console.log("  Matrix unresolved:", matrix.unresolved.length);
  console.log("  Matrix missing files:", report.matrix.missingFiles.length);
  console.log("  Fixture failures:", fixtureFailures.length);
  console.log("  Report:", outPath);

  if (fixtureFailures.length) {
    console.log("\nFixture failures:");
    for (const f of fixtureFailures) {
      console.log(" ", JSON.stringify(f));
    }
  }

  if (!report.ok) {
    process.exit(1);
  }
  console.log("\nOK — all checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
