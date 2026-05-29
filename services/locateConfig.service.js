/**
 * Read/update <locate> in /opt/tak/CoreConfig.xml via SSH (Settings handshake).
 */

const takSshSvc = require("./takSsh.service");

const CORE_CONFIG_PATH = "/opt/tak/CoreConfig.xml";

function escapeXmlAttr(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function unescapeXmlAttr(s) {
  return String(s || "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function removeLocateElements(xml) {
  let s = String(xml || "");
  // Remove newline + indented locate line (typical formatting after insert)
  s = s.replace(/\r?\n[ \t]*<locate\b[^>]*\/>[ \t]*/gi, "");
  // Any remaining locate tag (same-line / edge cases)
  s = s.replace(/<locate\b[^>]*\/>/gi, "");
  // Collapse extra blank lines left before <vbm> (e.g. blank line that sat under locate)
  s = s.replace(/(\r?\n)(?:[ \t]*\r?\n)+([ \t]*<vbm\b)/gi, "$1$2");
  return s;
}

function buildLocateTag({ groupDisplayName, missionTitle, addToMission }) {
  const g = escapeXmlAttr(groupDisplayName ?? "");
  const add = addToMission === true ? "true" : "false";
  const mis =
    addToMission === true && missionTitle != null && String(missionTitle).trim()
      ? escapeXmlAttr(String(missionTitle).trim())
      : "";
  return `<locate enabled="true" requireLogin="false" cot-type="a-h-G" group="${g}" addToMission="${add}" mission="${mis}"/>`;
}

/**
 * Insert <locate> on its own line after <cluster/> when present (matches typical CoreConfig layout).
 * Handles <cluster/><vbm on one line so locate is not glued to cluster or vbm.
 */
function insertLocateInConfig(xml, locateLine) {
  const body = removeLocateElements(xml);

  // <cluster/> and <vbm on the same line (no newline between)
  if (/<cluster\s*\/>\s*<vbm\b/i.test(body)) {
    return body.replace(
      /([ \t]*)<cluster\s*\/>\s*(<vbm\b)/i,
      (_full, spaces, vbmTag) => `${spaces}<cluster/>\n${spaces}${locateLine}\n${spaces}${vbmTag}`
    );
  }

  // <cluster/> with following content on later lines — add locate directly under cluster
  if (/<cluster\s*\/>/i.test(body)) {
    return body.replace(
      /([ \t]*)<cluster\s*\/>/i,
      (full, spaces) => `${spaces}<cluster/>\n${spaces}${locateLine}`
    );
  }

  // No cluster: insert before <vbm>, matching indentation of the vbm line
  if (/<vbm\b/i.test(body)) {
    return body.replace(/(\s*)(<vbm\b)/i, (_full, ws, vbmTag) => {
      const trimmed = String(ws || "");
      const indMatch = trimmed.match(/([ \t]*)$/);
      const indent = indMatch ? indMatch[1] : "    ";
      const prefix = trimmed.slice(0, Math.max(0, trimmed.length - indent.length));
      return `${prefix}${indent}${locateLine}\n${indent}${vbmTag}`;
    });
  }

  return body.replace(/(\s*)<\/Configuration>/i, (_m, indent) => `${locateLine}\n${indent}</Configuration>`);
}

function parseLocateFromXml(xml) {
  const m = String(xml || "").match(/<locate\b([^>]*)\/>/i);
  if (!m) return { enabled: false, group: "", addToMission: false, mission: "" };
  const attrs = m[1] || "";
  const en = /enabled\s*=\s*"([^"]*)"/i.exec(attrs);
  const gr = /group\s*=\s*"([^"]*)"/i.exec(attrs);
  const am = /addToMission\s*=\s*"([^"]*)"/i.exec(attrs);
  // Must not match the "Mission=" inside addToMission="…" (that wrongly captured "true").
  const mi = /\smission\s*=\s*"([^"]*)"/i.exec(attrs);
  const enabled = String(en?.[1] || "").toLowerCase() === "true";
  const group = unescapeXmlAttr(gr?.[1] || "");
  const addToMission = String(am?.[1] || "").toLowerCase() === "true";
  const mission = unescapeXmlAttr(mi?.[1] || "");
  return { enabled, group, addToMission, mission };
}

function isSshConfigured() {
  const cfg = takSshSvc.getTakSshConfig();
  return { configured: !!cfg };
}

async function readRemoteCoreConfigXml() {
  const result = await takSshSvc.runRemotePrivilegedCommand(`cat ${CORE_CONFIG_PATH}`, 90000);
  if (!result.ok) {
    throw new Error(result.message || "Failed to read CoreConfig.xml over SSH.");
  }
  return result.stdout || "";
}

async function applyLocateConfiguration({ enabled, groupDisplayName, missionName }) {
  const ssh = isSshConfigured();
  if (!ssh.configured) {
    throw new Error("SSH is not configured. Complete the SSH handshake in Settings first.");
  }

  const xml = await readRemoteCoreConfigXml();
  let next;
  if (enabled) {
    const g = String(groupDisplayName ?? "").trim();
    const m = String(missionName ?? "").trim();
    const addToMission = !!m;
    const locateLine = buildLocateTag({
      groupDisplayName: g,
      addToMission,
      missionTitle: m,
    });
    next = insertLocateInConfig(xml, locateLine);
  } else {
    next = removeLocateElements(xml);
  }

  const writeResult = await takSshSvc.writeRemoteFileViaSudoTee(CORE_CONFIG_PATH, next);
  if (!writeResult.ok) {
    throw new Error(writeResult.message || "Failed to write CoreConfig.xml.");
  }

  const restartResult = await takSshSvc.runRemotePrivilegedCommand("systemctl restart takserver", 120000);
  if (!restartResult.ok) {
    throw new Error(restartResult.message || "CoreConfig.xml was updated but TAK Server restart failed.");
  }

  return { message: "Locate settings applied and TAK Server is currently restarting." };
}

module.exports = {
  CORE_CONFIG_PATH,
  escapeXmlAttr,
  parseLocateFromXml,
  isSshConfigured,
  readRemoteCoreConfigXml,
  applyLocateConfiguration,
};
