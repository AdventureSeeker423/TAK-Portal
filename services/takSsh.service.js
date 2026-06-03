/**
 * services/takSsh.service.js
 *
 * Run makeCert.sh on the TAK server via SSH when creating an integration user.
 * Used so that nodered-* integration users get a client cert on the TAK server.
 *
 * Settings (all optional; if not set, cert creation is skipped):
 *   TAK_SSH_HOST       SSH host (default: hostname from TAK_URL)
 *   TAK_SSH_PORT       SSH port (default: 22)
 *   TAK_SSH_USER       SSH username (non-root OK; handshake configures sudo)
 *   TAK_SSH_SUDO_PASSWORD Optional fallback when passwordless sudo cannot be installed
 *   TAK_SSH_PRIVATE_KEY_PATH   Path to PEM private key file
 *   TAK_SSH_PASSPHRASE Optional passphrase for encrypted key
 *
 * Command run on server: sudo -u tak bash -c 'cd /opt/tak/certs && ./makeCert.sh client <username>'
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client, utils: sshUtils } = require("ssh2");
const { getString, getInt, getBool } = require("./env");
const settingsSvc = require("./settings.service");

const DATA_SSH_DIR = path.join(__dirname, "..", "data", "ssh");
const DEFAULT_PRIVATE_KEY_PATH = path.join(DATA_SSH_DIR, "tak_ssh_ed25519");
const DEFAULT_PUBLIC_KEY_PATH = path.join(DATA_SSH_DIR, "tak_ssh_ed25519.pub");
const INTEGRATION_CERTS_DIR = path.join(__dirname, "..", "data", "integration-certs");

function resolvePathMaybe(p) {
  if (!p || !String(p).trim()) return null;
  const raw = String(p).trim();
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function quoteForSingleQuotedShell(str) {
  return String(str || "").replace(/'/g, "'\"'\"'");
}

const PRIVILEGED_UNAVAILABLE_MSG =
  "SSH connected but privileged commands are not available. In Server Settings, run Generate Key + Handshake again with an account that can sudo (the portal installs passwordless sudo automatically).";

const TAK_CORE_CONFIG_PATH = "/opt/tak/CoreConfig.xml";
const TAK_CERTS_DIR = "/opt/tak/certs";
const TAK_PORTAL_CERTS_REPAIR_SCRIPT = "/opt/tak/utils/tak-portal-repair-certs.sh";

/** Shell checks that match commands granted in /etc/sudoers.d/tak-portal (not bare `sudo true`). */
function shellProbeNopasswdRootAccess() {
  return `sudo -n cat ${TAK_CORE_CONFIG_PATH} >/dev/null 2>&1`;
}

function shellProbeNopasswdAsTakUser() {
  return "sudo -n -u tak id >/dev/null 2>&1";
}

function shellProbePasswordSudoAccess(password) {
  const safePass = quoteForSingleQuotedShell(password);
  return `printf '%s\\n' '${safePass}' | sudo -S -p '' cat ${TAK_CORE_CONFIG_PATH} >/dev/null 2>&1`;
}

let privilegedModeCache = null;

function clearPrivilegedModeCache() {
  privilegedModeCache = null;
}

function connectConfigKey(connectConfig) {
  return `${connectConfig.host}:${connectConfig.port}:${connectConfig.username}`;
}

function toConnectConfig(cfg) {
  return {
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    privateKey: cfg.privateKey,
    passphrase: cfg.passphrase,
    readyTimeout: 15000,
  };
}

function getSudoPasswordFromSettings() {
  return String(getString("TAK_SSH_SUDO_PASSWORD", "") || "").trim();
}

function assertSafePortalSshUsername(username) {
  const u = String(username || "").trim();
  if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,31}$/.test(u)) {
    throw new Error("SSH username contains unsupported characters for remote sudo setup.");
  }
  return u;
}

function buildPrivilegedCommand(innerCommand, mode, options = {}) {
  const runAsUser = String(options.runAsUser || "").trim();
  if (!mode || mode.mode === "none") {
    throw new Error(PRIVILEGED_UNAVAILABLE_MSG);
  }

  if (mode.mode === "direct") {
    if (runAsUser) {
      throw new Error(
        "SSH user can access CoreConfig directly but cannot run commands as the tak user. Use an account with sudo or re-run Configure Sudo Access."
      );
    }
    return innerCommand;
  }
  if (mode.mode === "root") {
    if (runAsUser) return `sudo -u ${runAsUser} ${innerCommand}`;
    return innerCommand;
  }
  if (mode.mode === "nopasswd") {
    if (runAsUser) return `sudo -n -u ${runAsUser} ${innerCommand}`;
    return `sudo -n ${innerCommand}`;
  }
  if (mode.mode === "password" && mode.password) {
    const safePass = quoteForSingleQuotedShell(mode.password);
    if (runAsUser) {
      return `printf '%s\\n' '${safePass}' | sudo -S -p '' -u ${runAsUser} ${innerCommand}`;
    }
    return `printf '%s\\n' '${safePass}' | sudo -S -p '' ${innerCommand}`;
  }
  throw new Error(PRIVILEGED_UNAVAILABLE_MSG);
}

function buildPrivilegedTeeCommand(remoteAbsolutePath, mode) {
  const safePath = quoteForSingleQuotedShell(String(remoteAbsolutePath || "").trim());
  const teeInner = `tee '${safePath}' > /dev/null`;
  if (mode.mode === "root") return teeInner;
  if (mode.mode === "nopasswd") return `sudo -n ${teeInner}`;
  if (mode.mode === "password" && mode.password) {
    const safePass = quoteForSingleQuotedShell(mode.password);
    return `(printf '%s\\n' '${safePass}'; cat) | sudo -S -p '' ${teeInner}`;
  }
  throw new Error(PRIVILEGED_UNAVAILABLE_MSG);
}

async function probePrivilegedMode(connectConfig) {
  const idRes = await execOverSsh(connectConfig, "id -u", 15000);
  if (idRes.ok && String(idRes.stdout || "").trim() === "0") {
    return { mode: "root" };
  }

  const canRead = await execOverSsh(connectConfig, `test -r ${TAK_CORE_CONFIG_PATH}`, 15000);
  const canWrite = await execOverSsh(connectConfig, `test -w ${TAK_CORE_CONFIG_PATH}`, 15000);
  if (canRead.ok && canWrite.ok) {
    return { mode: "direct" };
  }

  const nopassRoot = await execOverSsh(connectConfig, shellProbeNopasswdRootAccess(), 15000);
  if (nopassRoot.ok) {
    return { mode: "nopasswd" };
  }

  const nopassTak = await execOverSsh(connectConfig, shellProbeNopasswdAsTakUser(), 15000);
  if (nopassTak.ok) {
    return { mode: "nopasswd" };
  }

  const sudoPassword = getSudoPasswordFromSettings();
  if (sudoPassword) {
    const passRes = await execOverSsh(connectConfig, shellProbePasswordSudoAccess(sudoPassword), 20000);
    if (passRes.ok) {
      return { mode: "password", password: sudoPassword };
    }
  }

  return { mode: "none" };
}

async function installPortalSudoersUsingStoredPassword(connectConfig, portalUsername) {
  const password = getSudoPasswordFromSettings();
  if (!password) {
    return { ok: false, message: "No stored sudo password." };
  }
  return installPortalSudoersOnRemote(connectConfig, password, portalUsername);
}

async function getPrivilegedMode(connectConfig, { forceRefresh = false } = {}) {
  const key = connectConfigKey(connectConfig);
  if (!forceRefresh && privilegedModeCache && privilegedModeCache.key === key) {
    return privilegedModeCache.mode;
  }

  let mode = await probePrivilegedMode(connectConfig);

  const sudoersConfigured = String(getString("TAK_SSH_SUDOERS_CONFIGURED", "")).toLowerCase() === "true";
  if (!sudoersConfigured && mode.mode === "password" && mode.password) {
    const install = await installPortalSudoersUsingStoredPassword(connectConfig, connectConfig.username);
    if (install.ok) {
      mode = await probePrivilegedMode(connectConfig);
      await deployTakPortalCertsRepairScript(connectConfig, mode);
      await runTakPortalCertsRepair(connectConfig, mode);
      const current = settingsSvc.getSettings() || {};
      settingsSvc.saveSettings({
        ...current,
        TAK_SSH_SUDOERS_CONFIGURED: "true",
      });
      mode = await probePrivilegedMode(connectConfig);
    }
  }

  privilegedModeCache = { key, mode };
  return mode;
}

function buildTakPortalCertsRepairScriptContent() {
  return `#!/bin/bash
set -euo pipefail
CERTS='${TAK_CERTS_DIR}'
mkdir -p "$CERTS/files"
chmod -R u+rwX,go+rX "$CERTS"/*.sh 2>/dev/null || true
chmod 644 "$CERTS/cert-metadata.sh" "$CERTS/makeCert.sh" 2>/dev/null || true
chown -R tak:tak "$CERTS"
`;
}

function buildPortalSudoersInstallScript(portalUsername) {
  const user = assertSafePortalSshUsername(portalUsername);
  const repairScript = TAK_PORTAL_CERTS_REPAIR_SCRIPT;
  return `#!/bin/bash
set -euo pipefail
PORTAL_USER='${user}'
CAT="$(command -v cat)"
TEE="$(command -v tee)"
BASH="$(command -v bash)"
SYSTEMCTL="$(command -v systemctl)"
TAIL="$(command -v tail)"
VISUDO="$(command -v visudo)"
REBOOT="$(command -v reboot 2>/dev/null || true)"
if [ -z "$REBOOT" ] || [ ! -x "$REBOOT" ]; then
  for p in /sbin/reboot /usr/sbin/reboot; do
    if [ -x "$p" ]; then REBOOT="$p"; break; fi
  done
fi
umask 077
TMP="$(mktemp)"
{
  echo "Defaults:$PORTAL_USER !requiretty"
  echo "$PORTAL_USER ALL=(root) NOPASSWD: $CAT /opt/tak/CoreConfig.xml"
  echo "$PORTAL_USER ALL=(root) NOPASSWD: $TEE /opt/tak/CoreConfig.xml"
  echo "$PORTAL_USER ALL=(root) NOPASSWD: $TEE ${repairScript}"
  echo "$PORTAL_USER ALL=(root) NOPASSWD: $BASH ${repairScript}"
  echo "$PORTAL_USER ALL=(root) NOPASSWD: $SYSTEMCTL restart takserver"
  echo "$PORTAL_USER ALL=(tak) NOPASSWD: ALL"
  echo "$PORTAL_USER ALL=(root) NOPASSWD: $TAIL"
  if [ -n "$REBOOT" ] && [ -x "$REBOOT" ]; then
    echo "$PORTAL_USER ALL=(root) NOPASSWD: $REBOOT"
  fi
} > "$TMP"
chmod 440 "$TMP"
mv "$TMP" /etc/sudoers.d/tak-portal
"$VISUDO" -cf /etc/sudoers.d/tak-portal
`;
}

async function installPortalSudoersOnRemote(connectConfig, sshPassword, portalUsername) {
  const script = buildPortalSudoersInstallScript(portalUsername);
  const b64 = Buffer.from(script, "utf8").toString("base64");
  const safePass = quoteForSingleQuotedShell(String(sshPassword || ""));
  const cmd = `printf '%s\\n' '${safePass}' | sudo -S -p '' bash -lc 'echo ${b64} | base64 -d | bash'`;
  return execOverSsh(connectConfig, cmd, 90000);
}

function buildInlineTakCertsRepairCommand() {
  return (
    `bash -lc 'set -e; mkdir -p ${TAK_CERTS_DIR}/files; ` +
    `chmod -R u+rwX,go+rX ${TAK_CERTS_DIR}/*.sh 2>/dev/null || true; ` +
    `chmod 644 ${TAK_CERTS_DIR}/cert-metadata.sh ${TAK_CERTS_DIR}/makeCert.sh 2>/dev/null || true; ` +
    `chown -R tak:tak ${TAK_CERTS_DIR}'`
  );
}

async function deployTakPortalCertsRepairScript(connect, mode) {
  const content = buildTakPortalCertsRepairScriptContent();
  const teeResult = await writeRemoteFileViaSudoTeeOnConnect(connect, mode, TAK_PORTAL_CERTS_REPAIR_SCRIPT, content);
  if (teeResult.ok) return teeResult;

  const b64 = Buffer.from(content, "utf8").toString("base64");
  const inner =
    `bash -lc 'mkdir -p /opt/tak/utils && echo ${b64} | base64 -d > ${TAK_PORTAL_CERTS_REPAIR_SCRIPT}'`;
  const cmd = buildPrivilegedCommand(inner, mode);
  return execOverSsh(connect, cmd, 60000);
}

async function writeRemoteFileViaSudoTeeOnConnect(connect, mode, remoteAbsolutePath, contentUtf8) {
  const p = String(remoteAbsolutePath || "").trim();
  if (!p.startsWith("/")) {
    return { ok: false, message: "Remote path must be absolute.", stdout: "", stderr: "", exitCode: null };
  }
  try {
    const cmd = buildPrivilegedTeeCommand(p, mode);
    return execOverSshWithStdin(connect, cmd, contentUtf8, 180000);
  } catch (err) {
    return {
      ok: false,
      message: err?.message || String(err),
      stdout: "",
      stderr: "",
      exitCode: null,
    };
  }
}

async function runTakPortalCertsRepair(connect, mode) {
  const inner = `bash ${TAK_PORTAL_CERTS_REPAIR_SCRIPT}`;
  const cmd = buildPrivilegedCommand(inner, mode);
  return execOverSsh(connect, cmd, 30000);
}

async function runInlineTakCertsRepair(connect, mode) {
  const cmd = buildPrivilegedCommand(buildInlineTakCertsRepairCommand(), mode);
  return execOverSsh(connect, cmd, 30000);
}

async function runTakCertsRepairWithStoredSudoPassword(connect) {
  const password = getSudoPasswordFromSettings();
  if (!password) {
    return { ok: false, message: "No stored sudo password for cert repair." };
  }
  const safePass = quoteForSingleQuotedShell(password);
  const cmd = `printf '%s\\n' '${safePass}' | sudo -S -p '' ${buildInlineTakCertsRepairCommand()}`;
  return execOverSsh(connect, cmd, 30000);
}

/**
 * Ensure sudoers includes cert repair, deploy repair script, and fix /opt/tak/certs permissions.
 */
async function syncPortalSudoersForCertRepair(connect, portalUsername) {
  const probe = await execOverSsh(
    connect,
    `sudo -n bash ${TAK_PORTAL_CERTS_REPAIR_SCRIPT} >/dev/null 2>&1`,
    15000
  );
  if (probe.ok) return { ok: true };

  const user = assertSafePortalSshUsername(portalUsername || connect.username);
  const storedPw = getSudoPasswordFromSettings();
  if (storedPw) {
    const install = await installPortalSudoersOnRemote(connect, storedPw, user);
    if (!install.ok) {
      return { ok: false, message: install.message || "Could not refresh portal sudoers for cert repair." };
    }
    clearPrivilegedModeCache();
  }

  let mode = await getPrivilegedMode(connect, { forceRefresh: true });
  if (!storedPw && mode.mode === "password" && mode.password) {
    const install = await installPortalSudoersOnRemote(connect, mode.password, user);
    if (install.ok) {
      clearPrivilegedModeCache();
      mode = await getPrivilegedMode(connect, { forceRefresh: true });
    }
  }
  const deploy = await deployTakPortalCertsRepairScript(connect, mode);
  if (!deploy.ok) {
    const inline = await runInlineTakCertsRepair(connect, mode);
    if (!inline.ok) {
      const withPw = await runTakCertsRepairWithStoredSudoPassword(connect);
      if (!withPw.ok) {
        return {
          ok: false,
          message:
            deploy.message ||
            inline.message ||
            withPw.message ||
            "Could not deploy cert repair on the TAK server.",
        };
      }
    }
  } else {
    const repair = await runTakPortalCertsRepair(connect, mode);
    if (!repair.ok) {
      const inline = await runInlineTakCertsRepair(connect, mode);
      if (!inline.ok) {
        const withPw = await runTakCertsRepairWithStoredSudoPassword(connect);
        if (!withPw.ok) {
          return { ok: false, message: repair.message || inline.message || withPw.message };
        }
      }
    }
  }

  const verify = await execOverSsh(
    connect,
    `sudo -n bash ${TAK_PORTAL_CERTS_REPAIR_SCRIPT} >/dev/null 2>&1`,
    15000
  );
  if (verify.ok) return { ok: true };

  mode = await getPrivilegedMode(connect, { forceRefresh: true });
  const finalRepair = await runTakPortalCertsRepair(connect, mode);
  if (finalRepair.ok) return { ok: true };

  const finalInline = await runInlineTakCertsRepair(connect, mode);
  if (finalInline.ok) return { ok: true };

  return {
    ok: false,
    message:
      finalRepair.message ||
      finalInline.message ||
      "Certificate directory repair failed. In Server Settings, use Reconfigure Sudo with your SSH account password once, then retry.",
  };
}

/**
 * During handshake: install /etc/sudoers.d/tak-portal, or store sudo password for -S fallback.
 */
async function configureRemoteSudoAccessAfterHandshake({ host, port, username, password }) {
  const connect = {
    host,
    port,
    username,
    password,
    readyTimeout: 15000,
    tryKeyboard: true,
  };

  const portalUser = assertSafePortalSshUsername(username);
  const install = await installPortalSudoersOnRemote(connect, password, portalUser);
  if (install.ok) {
    clearPrivilegedModeCache();
    let verifyConnect = connect;
    const keyCfg = getTakSshConfig();
    if (keyCfg && keyCfg.username === portalUser && keyCfg.host === String(host || "").trim()) {
      verifyConnect = toConnectConfig(keyCfg);
    }
    const verified = await execOverSsh(verifyConnect, shellProbeNopasswdRootAccess(), 20000);
    if (verified.ok) {
      const mode = await getPrivilegedMode(verifyConnect, { forceRefresh: true });
      await deployTakPortalCertsRepairScript(verifyConnect, mode);
      await runTakPortalCertsRepair(verifyConnect, mode);
      return { ok: true, method: "sudoers" };
    }
    console.warn(
      "[TAK SSH] sudoers install exited 0 but passwordless verify failed:",
      verified.message || verified.stderr || install.stderr || "unknown"
    );
  }

  const passRes = await execOverSsh(connect, shellProbePasswordSudoAccess(password), 20000);
  if (passRes.ok) {
    return { ok: true, method: "password", sudoPassword: password };
  }

  console.warn(
    "[TAK SSH] Could not configure passwordless sudo for portal user:",
    install.message || install.stderr || passRes.message || passRes.stderr || "unknown"
  );
  return {
    ok: false,
    method: "none",
    message:
      install.message ||
      passRes.message ||
      passRes.stderr ||
      "sudo configuration failed (install and password sudo checks both failed)",
  };
}

function sanitizeIntegrationUsername(username) {
  const un = String(username || "").trim().toLowerCase();
  if (!/^nodered-[a-z0-9-]+$/.test(un)) {
    throw new Error("Invalid integration username.");
  }
  return un;
}

function getIntegrationCertPaths(username) {
  const un = sanitizeIntegrationUsername(username);
  return {
    username: un,
    dir: path.join(INTEGRATION_CERTS_DIR, un),
    pemPath: path.join(INTEGRATION_CERTS_DIR, un, `${un}.pem`),
    keyPath: path.join(INTEGRATION_CERTS_DIR, un, `${un}.key`),
    p12Path: path.join(INTEGRATION_CERTS_DIR, un, `${un}.p12`),
  };
}

function deleteStoredIntegrationCertFiles(username) {
  const p = getIntegrationCertPaths(username);
  try {
    if (fs.existsSync(p.pemPath)) fs.unlinkSync(p.pemPath);
  } catch (_) {}
  try {
    if (fs.existsSync(p.keyPath)) fs.unlinkSync(p.keyPath);
  } catch (_) {}
  try {
    if (fs.existsSync(p.p12Path)) fs.unlinkSync(p.p12Path);
  } catch (_) {}
  try {
    if (fs.existsSync(p.dir) && fs.readdirSync(p.dir).length === 0) fs.rmdirSync(p.dir);
  } catch (_) {}
}

function hasStoredIntegrationCertFiles(username) {
  const p = getIntegrationCertPaths(username);
  return fs.existsSync(p.pemPath) && fs.existsSync(p.keyPath);
}

function parseRemoteCertBundle(stdout) {
  const out = String(stdout || "");
  const pemMatch = out.match(/__TAK_CERT_PEM_BEGIN__\s*([\s\S]*?)\s*__TAK_CERT_PEM_END__/);
  const keyMatch = out.match(/__TAK_CERT_KEY_BEGIN__\s*([\s\S]*?)\s*__TAK_CERT_KEY_END__/);
  if (!pemMatch || !keyMatch) {
    throw new Error("Remote cert output could not be parsed.");
  }
  const pemB64 = String(pemMatch[1] || "").replace(/\s+/g, "");
  const keyB64 = String(keyMatch[1] || "").replace(/\s+/g, "");
  const pem = Buffer.from(pemB64, "base64").toString("utf8").trim();
  const key = Buffer.from(keyB64, "base64").toString("utf8").trim();
  if (!pem || !key) {
    throw new Error("Remote cert output was empty.");
  }
  const p12Match = out.match(/__TAK_CERT_P12_BEGIN__\s*([\s\S]*?)\s*__TAK_CERT_P12_END__/);
  let p12 = null;
  if (p12Match) {
    const p12B64 = String(p12Match[1] || "").replace(/\s+/g, "");
    if (p12B64) {
      const buf = Buffer.from(p12B64, "base64");
      if (buf.length) p12 = buf;
    }
  }
  return { pem: pem + "\n", key: key + "\n", p12 };
}

async function fetchIntegrationCertPairFromRemote(username) {
  const un = sanitizeIntegrationUsername(username);
  const cfg = getTakSshConfig();
  if (!cfg) {
    throw new Error("SSH is not configured. Complete SSH handshake in Settings.");
  }

  const safeName = quoteForSingleQuotedShell(un);
  const remoteScript =
    "bash -lc 'set -e; cd /opt/tak/certs; " +
    `name='${safeName}'; ` +
    "pem=''; key=''; p12path=''; " +
    "for p in \"./files/${name}.pem\" \"./${name}.pem\" \"/opt/tak/certs/files/${name}.pem\" \"/opt/tak/certs/${name}.pem\"; do [ -f \"$p\" ] && pem=\"$p\" && break; done; " +
    "for k in \"./files/${name}.key\" \"./${name}.key\" \"/opt/tak/certs/files/${name}.key\" \"/opt/tak/certs/${name}.key\"; do [ -f \"$k\" ] && key=\"$k\" && break; done; " +
    "for f in \"./files/${name}.p12\" \"./${name}.p12\" \"/opt/tak/certs/files/${name}.p12\" \"/opt/tak/certs/${name}.p12\"; do [ -f \"$f\" ] && p12path=\"$f\" && break; done; " +
    "if [ -z \"$pem\" ] || [ -z \"$key\" ]; then echo \"Missing cert files for ${name}\" 1>&2; exit 44; fi; " +
    "echo __TAK_CERT_PEM_BEGIN__; base64 \"$pem\" | tr -d \"\\n\"; echo; echo __TAK_CERT_PEM_END__; " +
    "echo __TAK_CERT_KEY_BEGIN__; base64 \"$key\" | tr -d \"\\n\"; echo; echo __TAK_CERT_KEY_END__; " +
    "if [ -n \"$p12path\" ]; then echo __TAK_CERT_P12_BEGIN__; base64 \"$p12path\" | tr -d \"\\n\"; echo; echo __TAK_CERT_P12_END__; fi'";

  const connect = toConnectConfig(cfg);
  const mode = await getPrivilegedMode(connect);
  const command = buildPrivilegedCommand(remoteScript, mode, { runAsUser: "tak" });
  const result = await execOverSsh(connect, command);

  if (!result.ok) {
    throw new Error(result.message || "Failed to fetch integration cert files from TAK server.");
  }
  return parseRemoteCertBundle(result.stdout);
}

async function storeIntegrationCertPairLocally(username, certPair) {
  const p = getIntegrationCertPaths(username);
  ensureDir(p.dir);
  fs.writeFileSync(p.pemPath, String(certPair.pem || ""), { mode: 0o600 });
  fs.writeFileSync(p.keyPath, String(certPair.key || ""), { mode: 0o600 });
  if (certPair.p12 && Buffer.isBuffer(certPair.p12) && certPair.p12.length > 0) {
    fs.writeFileSync(p.p12Path, certPair.p12, { mode: 0o600 });
  }
  return p;
}

async function provisionIntegrationCertFiles(username) {
  const un = sanitizeIntegrationUsername(username);
  // First try to fetch existing cert files (covers integrations created before
  // this feature, where certs may already exist on the TAK server).
  try {
    const existingPair = await fetchIntegrationCertPairFromRemote(un);
    const existingStored = await storeIntegrationCertPairLocally(un, existingPair);
    return { ok: true, username: un, ...existingStored, usedExistingRemoteFiles: true };
  } catch (_) {
    // If not present yet, continue with generation flow.
  }

  const makeResult = await createTakClientCertForIntegration(un);
  if (!makeResult.ok) {
    throw new Error(makeResult.message || "makeCert.sh failed.");
  }

  const pair = await fetchIntegrationCertPairFromRemote(un);
  const stored = await storeIntegrationCertPairLocally(un, pair);
  return { ok: true, username: un, ...stored, usedExistingRemoteFiles: false };
}

async function getOrProvisionIntegrationCertFiles(username) {
  const un = sanitizeIntegrationUsername(username);
  if (hasStoredIntegrationCertFiles(un)) {
    const paths = getIntegrationCertPaths(un);
    if (!fs.existsSync(paths.p12Path)) {
      try {
        const bundle = await fetchIntegrationCertPairFromRemote(un);
        await storeIntegrationCertPairLocally(un, bundle);
      } catch (_) {
        // Keep serving pem/key from cache if a refresh for .p12 fails.
      }
    }
    return { ok: true, ...getIntegrationCertPaths(un), fromCache: true };
  }
  return provisionIntegrationCertFiles(un);
}

async function revokeIntegrationCertViaSshScript(username) {
  const un = sanitizeIntegrationUsername(username);
  const cfg = getTakSshConfig();
  if (!cfg) {
    throw new Error("SSH is not configured. Complete SSH handshake in Settings.");
  }

  const safeName = quoteForSingleQuotedShell(un);
  const revokeInner =
    "bash -lc 'set -e; cd /opt/tak/certs; " +
    `./revokeCert.sh files/${safeName} files/ca-do-not-share files/ca'`;

  const connect = toConnectConfig(cfg);
  const mode = await getPrivilegedMode(connect);
  const revokeCommand = buildPrivilegedCommand(revokeInner, mode, { runAsUser: "tak" });
  const result = await execOverSsh(connect, revokeCommand, 45000);

  if (!result.ok) {
    throw new Error(result.message || "Failed to revoke integration cert via SSH script.");
  }

  // Cleanup integration certificate artifacts after revoke.
  // We intentionally ignore "file not found" outcomes so cleanup is idempotent.
  const cleanupInner =
    "bash -lc 'set -e; cd /opt/tak/certs; " +
    `name='${safeName}'; ` +
    "for ext in csr jks key p12 pem; do " +
    "rm -f \"./files/${name}.${ext}\" \"./${name}.${ext}\"; " +
    "done; " +
    "rm -f \"./files/${name}-trusted.pem\" \"./${name}-trusted.pem\"'";

  const cleanupCommand = buildPrivilegedCommand(cleanupInner, mode, { runAsUser: "tak" });
  const cleanupResult = await execOverSsh(
    connect,
    cleanupCommand,
    30000
  );
  if (!cleanupResult.ok) {
    throw new Error(cleanupResult.message || "Certificate revoke succeeded, but cleanup failed.");
  }

  deleteStoredIntegrationCertFiles(un);
  return { ok: true, username: un };
}

function isUsablePrivateKey(privateKeyText, passphrase) {
  try {
    const parsed = sshUtils.parseKey(String(privateKeyText || ""), passphrase);
    if (parsed instanceof Error) return false;
    if (Array.isArray(parsed)) {
      return parsed.length > 0 && parsed.every((p) => !(p instanceof Error));
    }
    return !!parsed;
  } catch (_) {
    return false;
  }
}

function b64UrlToBuffer(input) {
  const s = String(input || "");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (b64.length % 4)) % 4;
  return Buffer.from(b64 + "=".repeat(padLen), "base64");
}

function packSshString(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length, 0);
  return Buffer.concat([len, b]);
}

function toMpint(buf) {
  let b = Buffer.isBuffer(buf) ? Buffer.from(buf) : Buffer.from(buf || []);
  while (b.length > 0 && b[0] === 0x00) {
    b = b.slice(1);
  }
  if (b.length === 0) return Buffer.alloc(0);
  if (b[0] & 0x80) {
    return Buffer.concat([Buffer.from([0x00]), b]);
  }
  return b;
}

function buildSshRsaPublicFromJwk(jwk, comment) {
  const e = toMpint(b64UrlToBuffer(jwk.e));
  const n = toMpint(b64UrlToBuffer(jwk.n));
  const payload = Buffer.concat([
    packSshString(Buffer.from("ssh-rsa")),
    packSshString(e),
    packSshString(n),
  ]);
  return `ssh-rsa ${payload.toString("base64")} ${comment || "tak-portal"}`;
}

function getTakUrlHostname() {
  const raw = String(getString("TAK_URL", "")).trim();
  if (!raw) return null;
  try {
    return new URL(raw).hostname;
  } catch {
    return null;
  }
}

/**
 * @returns { { host, port, username, privateKey, passphrase? } | null }
 *   Config for SSH, or null if SSH is not configured (skip cert creation).
 */
function getTakSshConfig() {
  let keyPath = resolvePathMaybe(getString("TAK_SSH_PRIVATE_KEY_PATH", ""));
  if (!keyPath && fs.existsSync(DEFAULT_PRIVATE_KEY_PATH)) {
    keyPath = DEFAULT_PRIVATE_KEY_PATH;
  }
  if (!keyPath || !fs.existsSync(keyPath)) return null;

  let privateKey;
  try {
    privateKey = fs.readFileSync(keyPath, "utf8");
  } catch (err) {
    console.warn("[TAK SSH] Could not read private key:", err?.message || err);
    return null;
  }

  if (!isUsablePrivateKey(privateKey, undefined)) {
    console.warn("[TAK SSH] Private key exists but is not parseable by ssh2.");
    return null;
  }

  const username = String(getString("TAK_SSH_USER", "")).trim();
  if (!username) return null;

  let host = String(getString("TAK_SSH_HOST", "")).trim();
  if (!host) host = getTakUrlHostname();
  if (!host) return null;

  const port = getInt("TAK_SSH_PORT", 22) || 22;
  const passphrase = getString("TAK_SSH_PASSPHRASE", "").trim() || undefined;

  return { host, port, username, privateKey, passphrase };
}

function getLocalKeyStatus() {
  const privateKeyPath = resolvePathMaybe(getString("TAK_SSH_PRIVATE_KEY_PATH", "")) || DEFAULT_PRIVATE_KEY_PATH;
  const publicKeyPath = resolvePathMaybe(getString("TAK_SSH_PUBLIC_KEY_PATH", "")) || DEFAULT_PUBLIC_KEY_PATH;
  const hasPrivateKey = fs.existsSync(privateKeyPath);
  const hasPublicKey = fs.existsSync(publicKeyPath);

  return {
    privateKeyPath: path.relative(process.cwd(), privateKeyPath).replace(/\\/g, "/"),
    publicKeyPath: path.relative(process.cwd(), publicKeyPath).replace(/\\/g, "/"),
    hasPrivateKey,
    hasPublicKey,
    hasKeyPair: hasPrivateKey && hasPublicKey,
  };
}

function ensureLocalSshKeyPair() {
  ensureDir(DATA_SSH_DIR);

  if (fs.existsSync(DEFAULT_PRIVATE_KEY_PATH) && fs.existsSync(DEFAULT_PUBLIC_KEY_PATH)) {
    try {
      const existingPrivate = fs.readFileSync(DEFAULT_PRIVATE_KEY_PATH, "utf8");
      if (isUsablePrivateKey(existingPrivate, undefined)) {
        return getLocalKeyStatus();
      }
      console.warn("[TAK SSH] Existing private key is invalid. Regenerating.");
    } catch (_) {
      // Regenerate below.
    }
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 4096,
    publicExponent: 0x10001,
  });
  const privatePem = privateKey.export({ format: "pem", type: "pkcs1" });
  fs.writeFileSync(DEFAULT_PRIVATE_KEY_PATH, String(privatePem), { mode: 0o600 });

  const jwk = publicKey.export({ format: "jwk" });
  const opensshPublic = buildSshRsaPublicFromJwk(jwk, "tak-portal");
  fs.writeFileSync(DEFAULT_PUBLIC_KEY_PATH, String(opensshPublic).trim() + "\n", {
    mode: 0o644,
  });

  const verifyPrivate = fs.readFileSync(DEFAULT_PRIVATE_KEY_PATH, "utf8");
  if (!isUsablePrivateKey(verifyPrivate, undefined)) {
    throw new Error("Generated private key is not parseable by ssh2.");
  }

  // Keep settings pointed at generated keys so they survive restart/redeploy.
  const current = settingsSvc.getSettings() || {};
  const next = { ...current };
  next.TAK_SSH_PRIVATE_KEY_PATH = path.relative(process.cwd(), DEFAULT_PRIVATE_KEY_PATH).replace(/\\/g, "/");
  next.TAK_SSH_PUBLIC_KEY_PATH = path.relative(process.cwd(), DEFAULT_PUBLIC_KEY_PATH).replace(/\\/g, "/");
  settingsSvc.saveSettings(next);

  return getLocalKeyStatus();
}

function execOverSshWithStdin(connectConfig, command, stdinUtf8, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const conn = new Client();
    let finished = false;
    const done = (payload) => {
      if (finished) return;
      finished = true;
      clearTimeout(t);
      try {
        conn.end();
      } catch (_) {}
      resolve(payload);
    };

    const t = setTimeout(() => {
      done({ ok: false, message: "SSH command timed out.", stdout: "", stderr: "", exitCode: null });
    }, timeoutMs);

    conn
      .on("keyboard-interactive", (name, instructions, instructionsLang, prompts, finish) => {
        if (connectConfig && connectConfig.password) {
          finish([String(connectConfig.password)]);
          return;
        }
        finish([]);
      })
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            done({ ok: false, message: err.message || String(err), stdout: "", stderr: "", exitCode: null });
            return;
          }

          let stdout = "";
          let stderr = "";
          stream.on("data", (data) => {
            stdout += data.toString();
          });
          stream.stderr.on("data", (data) => {
            stderr += data.toString();
          });
          stream.on("close", (code) => {
            const exitCode = Number.isInteger(code) ? code : null;
            if (exitCode !== 0) {
              done({
                ok: false,
                message: stderr.trim() || stdout.trim() || `Exit code ${exitCode}`,
                stdout,
                stderr,
                exitCode,
              });
              return;
            }
            done({ ok: true, stdout, stderr, exitCode: 0 });
          });

          const input = String(stdinUtf8 || "");
          stream.end(Buffer.from(input, "utf8"));
        });
      })
      .on("error", (err) => {
        done({ ok: false, message: err.message || String(err), stdout: "", stderr: "", exitCode: null });
      })
      .connect(connectConfig);
  });
}

/**
 * Write full file contents on the remote host (e.g. CoreConfig.xml) via stdin to `sudo tee`.
 * @param {string} remoteAbsolutePath
 * @param {string} contentUtf8
 */
async function writeRemoteFileViaSudoTee(remoteAbsolutePath, contentUtf8) {
  const p = String(remoteAbsolutePath || "").trim();
  if (!p.startsWith("/")) {
    return { ok: false, message: "Remote path must be absolute.", stdout: "", stderr: "", exitCode: null };
  }
  const cfg = getTakSshConfig();
  if (!cfg) {
    return {
      ok: false,
      message: "SSH is not configured. Complete the SSH handshake in Settings first.",
      stdout: "",
      stderr: "",
      exitCode: null,
    };
  }
  const connect = toConnectConfig(cfg);
  let mode;
  try {
    mode = await getPrivilegedMode(connect);
    const cmd = buildPrivilegedTeeCommand(p, mode);
    return execOverSshWithStdin(connect, cmd, contentUtf8, 180000);
  } catch (err) {
    return {
      ok: false,
      message: err?.message || String(err),
      stdout: "",
      stderr: "",
      exitCode: null,
    };
  }
}

/**
 * Run a command on the remote host as root (via direct root login, NOPASSWD sudo, or stored sudo password).
 * @param {string} rootShellCommand Command without a leading sudo (e.g. "cat '/opt/tak/CoreConfig.xml'").
 */
async function runRemotePrivilegedCommand(rootShellCommand, timeoutMs = 30000) {
  const inner = String(rootShellCommand || "").trim();
  if (!inner) {
    return { ok: false, message: "Command is required.", stdout: "", stderr: "", exitCode: null };
  }
  const cfg = getTakSshConfig();
  if (!cfg) {
    return {
      ok: false,
      message: "SSH is not configured. Complete the SSH handshake in Settings first.",
      stdout: "",
      stderr: "",
      exitCode: null,
    };
  }

  const connect = toConnectConfig(cfg);
  try {
    const mode = await getPrivilegedMode(connect);
    const cmd = buildPrivilegedCommand(inner, mode);
    return execOverSsh(connect, cmd, timeoutMs);
  } catch (err) {
    return {
      ok: false,
      message: err?.message || String(err),
      stdout: "",
      stderr: "",
      exitCode: null,
    };
  }
}

/**
 * Resolve a privileged remote command string (for long-running streamRemoteSshExec).
 */
async function resolvePrivilegedRemoteCommand(rootShellCommand, options = {}) {
  const inner = String(rootShellCommand || "").trim();
  if (!inner) throw new Error("Command is required.");
  const cfg = getTakSshConfig();
  if (!cfg) {
    throw new Error("SSH is not configured. Complete the SSH handshake in Settings first.");
  }
  const connect = toConnectConfig(cfg);
  const mode = await getPrivilegedMode(connect);
  return buildPrivilegedCommand(inner, mode, options);
}

function execOverSsh(connectConfig, command, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const conn = new Client();
    let finished = false;
    const done = (payload) => {
      if (finished) return;
      finished = true;
      clearTimeout(t);
      try {
        conn.end();
      } catch (_) {}
      resolve(payload);
    };

    const t = setTimeout(() => {
      done({ ok: false, message: "SSH command timed out.", stdout: "", stderr: "", exitCode: null });
    }, timeoutMs);

    conn
      .on("keyboard-interactive", (name, instructions, instructionsLang, prompts, finish) => {
        if (connectConfig && connectConfig.password) {
          finish([String(connectConfig.password)]);
          return;
        }
        finish([]);
      })
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            done({ ok: false, message: err.message || String(err), stdout: "", stderr: "", exitCode: null });
            return;
          }

          let stdout = "";
          let stderr = "";
          stream.on("data", (data) => {
            stdout += data.toString();
          });
          stream.stderr.on("data", (data) => {
            stderr += data.toString();
          });
          stream.on("close", (code) => {
            const exitCode = Number.isInteger(code) ? code : null;
            if (exitCode !== 0) {
              done({
                ok: false,
                message: stderr.trim() || stdout.trim() || `Exit code ${exitCode}`,
                stdout,
                stderr,
                exitCode,
              });
              return;
            }
            done({ ok: true, stdout, stderr, exitCode: 0 });
          });
        });
      })
      .on("error", (err) => {
        done({ ok: false, message: err.message || String(err), stdout: "", stderr: "", exitCode: null });
      })
      .connect(connectConfig);
  });
}

async function onboardTakSshWithPassword({ host, port, username, password }) {
  const h = String(host || "").trim();
  const u = String(username || "").trim();
  const p = String(password || "");
  const sshPort = Number.parseInt(String(port || "22"), 10) || 22;

  if (!h) throw new Error("Target host is required.");
  if (!u) throw new Error("SSH username is required.");
  if (!p) throw new Error("SSH password is required for first-time handshake.");

  const keyStatus = ensureLocalSshKeyPair();
  const pubKeyAbs = path.resolve(process.cwd(), keyStatus.publicKeyPath);
  const pubKey = fs.readFileSync(pubKeyAbs, "utf8").trim();
  if (!pubKey) throw new Error("Generated public key is empty.");

  const safePub = quoteForSingleQuotedShell(pubKey);
  const addKeyCommand =
    "umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys; " +
    `grep -qxF '${safePub}' ~/.ssh/authorized_keys || echo '${safePub}' >> ~/.ssh/authorized_keys`;

  const result = await execOverSsh(
    {
      host: h,
      port: sshPort,
      username: u,
      password: p,
      readyTimeout: 15000,
      tryKeyboard: true,
    },
    addKeyCommand
  );

  if (!result.ok) {
    throw new Error(result.message || "SSH handshake failed.");
  }

  const sudoSetup = await configureRemoteSudoAccessAfterHandshake({
    host: h,
    port: sshPort,
    username: u,
    password: p,
  });

  const current = settingsSvc.getSettings() || {};
  const nextSettings = {
    ...current,
    TAK_SSH_HOST: h,
    TAK_SSH_PORT: String(sshPort),
    TAK_SSH_USER: u,
    TAK_SSH_ONBOARDED: "true",
    TAK_SSH_LAST_HANDSHAKE_AT: new Date().toISOString(),
    TAK_SSH_PRIVATE_KEY_PATH: keyStatus.privateKeyPath,
    TAK_SSH_PUBLIC_KEY_PATH: keyStatus.publicKeyPath,
  };

  if (sudoSetup.method === "sudoers") {
    nextSettings.TAK_SSH_SUDOERS_CONFIGURED = "true";
    if (p) nextSettings.TAK_SSH_SUDO_PASSWORD = p;
  } else if (sudoSetup.method === "password" && sudoSetup.sudoPassword) {
    nextSettings.TAK_SSH_SUDO_PASSWORD = sudoSetup.sudoPassword;
    nextSettings.TAK_SSH_SUDOERS_CONFIGURED = "false";
  } else {
    nextSettings.TAK_SSH_SUDOERS_CONFIGURED = "false";
  }

  settingsSvc.saveSettings(nextSettings);
  clearPrivilegedModeCache();

  let message = "SSH key installed on remote server. Handshake complete.";
  if (sudoSetup.method === "sudoers") {
    message += " Passwordless sudo for TAK Portal was configured on the server.";
  } else if (sudoSetup.method === "password") {
    message += " Sudo access will use the handshake password when needed.";
  } else {
    message +=
      " Warning: could not configure sudo on the server; Locate and other privileged SSH actions may fail until you re-handshake with a sudo-capable account.";
  }

  return {
    ok: true,
    keyStatus: getLocalKeyStatus(),
    sudoSetup: sudoSetup.method,
    message,
  };
}

async function runRemoteSshCommand(command, timeoutMs = 30000) {
  const raw = String(command || "").trim();
  if (!raw) {
    return { ok: false, message: "Command is required.", stdout: "", stderr: "", exitCode: null };
  }
  const cfg = getTakSshConfig();
  if (!cfg) {
    return {
      ok: false,
      message: "SSH is not configured. Complete the SSH handshake in Settings first.",
      stdout: "",
      stderr: "",
      exitCode: null,
    };
  }

  return execOverSsh(
    {
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      privateKey: cfg.privateKey,
      passphrase: cfg.passphrase,
      readyTimeout: 15000,
    },
    raw,
    timeoutMs
  );
}

/**
 * Issue `sudo reboot` over SSH. The session often drops before a clean exit; treat timeout
 * or abrupt disconnect as "reboot likely started" when appropriate.
 * @returns {Promise<{ ok: boolean, initiated?: boolean, message?: string, exitCode?: number | null }>}
 */
async function runRemoteRebootFireAndForget() {
  const cfg = getTakSshConfig();
  if (!cfg) {
    return {
      ok: false,
      message: "SSH is not configured. Complete the SSH handshake in Settings first.",
    };
  }

  const connect = toConnectConfig(cfg);
  let rebootCmd;
  try {
    const mode = await getPrivilegedMode(connect);
    rebootCmd = buildPrivilegedCommand("reboot", mode);
  } catch (err) {
    return { ok: false, message: err?.message || String(err) };
  }

  return new Promise((resolve) => {
    const conn = new Client();
    let settled = false;
    const settle = (payload) => {
      if (settled) return;
      settled = true;
      try {
        clearTimeout(timer);
      } catch (_) {}
      try {
        conn.end();
      } catch (_) {}
      resolve(payload);
    };

    const timer = setTimeout(() => {
      settle({
        ok: true,
        initiated: true,
        message:
          "Reboot was requested; the SSH session did not return a final status (this is normal while the host restarts).",
      });
    }, 12000);

    conn
      .on("keyboard-interactive", (_n, _i, _il, _prompts, finish) => {
        finish([]);
      })
      .on("ready", () => {
        conn.exec(rebootCmd, (err, stream) => {
          if (err) {
            return settle({ ok: false, message: err.message || String(err) });
          }
          stream.on("data", () => {});
          stream.stderr.on("data", () => {});
          stream.on("close", (code) => {
            settle({
              ok: true,
              initiated: true,
              message: "Reboot command finished on the SSH channel.",
              exitCode: Number.isInteger(code) ? code : null,
            });
          });
        });
      })
      .on("error", (err) => {
        const msg = err?.message || String(err);
        if (/ECONNRESET|ECONNABORTED|Connection closed|Socket closed|disconnected/i.test(msg)) {
          settle({
            ok: true,
            initiated: true,
            message: "SSH disconnected; the host is likely rebooting.",
          });
        } else {
          settle({ ok: false, message: msg });
        }
      })
      .connect({
        host: connect.host,
        port: connect.port,
        username: connect.username,
        privateKey: connect.privateKey,
        passphrase: connect.passphrase,
        readyTimeout: 20000,
      });
  });
}

/**
 * Long-running remote command: stream stdout/stderr as UTF-8 chunks until the channel closes.
 * @param {string} command
 * @param {{
 *   onStdoutChunk?: (chunk: string) => void;
 *   onStderrChunk?: (chunk: string) => void;
 *   onClose?: () => void;
 *   onError?: (err: Error) => void;
 *   signal?: AbortSignal;
 * }} handlers
 * @returns {{ close: () => void }}
 */
function streamRemoteSshExec(command, handlers = {}) {
  const { onStdoutChunk, onStderrChunk, onClose, onError, signal } = handlers;
  const notifyError = (err) => {
    if (typeof onError === "function") onError(err instanceof Error ? err : new Error(String(err)));
  };
  const notifyClose = () => {
    if (typeof onClose === "function") onClose();
  };

  const cfg = getTakSshConfig();
  if (!cfg) {
    process.nextTick(() => {
      notifyError(new Error("SSH is not configured. Complete the SSH handshake in Settings first."));
      notifyClose();
    });
    return { close() {} };
  }

  const conn = new Client();
  let finished = false;
  const fireClose = () => {
    if (finished) return;
    finished = true;
    try {
      conn.end();
    } catch (_) {}
    notifyClose();
  };

  const close = () => {
    try {
      conn.end();
    } catch (_) {}
    fireClose();
  };

  if (signal) {
    if (signal.aborted) {
      process.nextTick(() => {
        notifyError(new Error("aborted"));
        fireClose();
      });
      return { close };
    }
    signal.addEventListener("abort", close, { once: true });
  }

  conn
    .on("keyboard-interactive", (_n, _i, _il, _prompts, finish) => {
      finish([]);
    })
    .on("ready", () => {
      conn.exec(String(command || ""), (err, stream) => {
        if (err) {
          notifyError(err);
          return fireClose();
        }
        stream.on("data", (buf) => {
          if (onStdoutChunk) onStdoutChunk(buf.toString("utf8"));
        });
        stream.stderr.on("data", (buf) => {
          if (onStderrChunk) onStderrChunk(buf.toString("utf8"));
        });
        stream.on("close", () => {
          fireClose();
        });
      });
    })
    .on("error", (err) => {
      if (finished) return;
      notifyError(err);
      fireClose();
    })
    .connect({
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      privateKey: cfg.privateKey,
      passphrase: cfg.passphrase,
      readyTimeout: 20000,
    });

  return { close };
}

/**
 * Verify (and repair via portal SSH) /opt/tak/certs so the tak user can source cert-metadata.sh.
 * makeCert.sh line 6 sources cert-metadata.sh; without read access DIR stays empty and mkdir fails.
 */
async function ensureRemoteTakCertEnvironment(connect, _mode, portalUsername) {
  const sync = await syncPortalSudoersForCertRepair(connect, portalUsername || connect.username);
  if (!sync.ok) {
    return sync;
  }

  const mode = await getPrivilegedMode(connect, { forceRefresh: true });
  const verifyAsTak =
    `bash -lc 'set -e; cd ${TAK_CERTS_DIR}; test -r cert-metadata.sh; . ./cert-metadata.sh; ` +
    '[ -n "$DIR" ] || DIR=files; export DIR; mkdir -p "$DIR"\'';

  const verifyCmd = buildPrivilegedCommand(verifyAsTak, mode, { runAsUser: "tak" });
  const result = await execOverSsh(connect, verifyCmd, 30000);
  if (result.ok) return { ok: true };

  const detail = String(result.stderr || result.message || "").trim();
  return {
    ok: false,
    message:
      detail ||
      "TAK certificate directory is still not usable after automated repair. In Server Settings, use Reconfigure Sudo with your SSH account password once, then retry.",
  };
}

/**
 * Run on TAK server: sudo -u tak bash -c 'cd /opt/tak/certs && ./makeCert.sh client <username>'
 * @param {string} username - Integration username (e.g. nodered-aircraft-all)
 * @returns { Promise<{ ok: boolean, skipped?: boolean, message?: string }> }
 */
async function createTakClientCertForIntegration(username) {
  const TAK_DEBUG = getBool("TAK_DEBUG", false);
  const bypass = getBool("TAK_BYPASS_ENABLED", false);
  if (bypass) {
    return { ok: false, skipped: true, message: "TAK bypass enabled." };
  }

  const un = String(username || "").trim();
  if (!un) return { ok: false, message: "Username required." };

  const config = getTakSshConfig();
  if (!config) {
    return {
      ok: false,
      skipped: true,
      message: "TAK SSH not configured (set TAK_SSH_USER and TAK_SSH_PRIVATE_KEY_PATH).",
    };
  }

  // Safe for shell: single-quote wrapped; username is alphanumeric + hyphens only for integrations
  const safeName = un.replace(/'/g, "'\"'\"'");
  const inner = `bash -lc 'cd ${TAK_CERTS_DIR} && ./makeCert.sh client ${safeName}'`;

  if (TAK_DEBUG) console.log("[TAK SSH] Connecting to", config.host + ":" + config.port, "as", config.username);

  const connect = toConnectConfig(config);
  const mode = await getPrivilegedMode(connect);
  const envCheck = await ensureRemoteTakCertEnvironment(connect, mode, config.username);
  if (!envCheck.ok) {
    return { ok: false, message: envCheck.message };
  }

  const command = buildPrivilegedCommand(inner, mode, { runAsUser: "tak" });
  const result = await execOverSsh(connect, command);
  if (!result.ok) return { ok: false, message: result.message };
  if (TAK_DEBUG) console.log("[TAK SSH] makeCert.sh succeeded for", un);
  return { ok: true };
}

/**
 * Verify key-based login and a sudoers-allowed privileged command (cat CoreConfig.xml).
 */
async function testSshConnectionAndPrivilegedAccess() {
  clearPrivilegedModeCache();
  const login = await runRemoteSshCommand("whoami");
  if (!login.ok) {
    return {
      ok: false,
      loginOk: false,
      message: login.message || "SSH login failed. Run full SSH setup with host, user, and password.",
    };
  }

  const priv = await runRemotePrivilegedCommand(`cat ${TAK_CORE_CONFIG_PATH} >/dev/null`, 20000);
  if (!priv.ok) {
    return {
      ok: false,
      loginOk: true,
      remoteUser: String(login.stdout || "").trim(),
      message:
        priv.message ||
        "SSH login works but privileged commands failed. Re-run full SSH setup with an account that can sudo.",
    };
  }

  return {
    ok: true,
    loginOk: true,
    remoteUser: String(login.stdout || "").trim(),
    message: "SSH setup verified: key login and privileged access (CoreConfig read) both succeeded.",
  };
}

module.exports = {
  getLocalKeyStatus,
  ensureLocalSshKeyPair,
  onboardTakSshWithPassword,
  configureRemoteSudoAccessAfterHandshake,
  testSshConnectionAndPrivilegedAccess,
  runRemoteSshCommand,
  runRemotePrivilegedCommand,
  resolvePrivilegedRemoteCommand,
  clearPrivilegedModeCache,
  runRemoteRebootFireAndForget,
  streamRemoteSshExec,
  writeRemoteFileViaSudoTee,
  hasStoredIntegrationCertFiles,
  provisionIntegrationCertFiles,
  getOrProvisionIntegrationCertFiles,
  revokeIntegrationCertViaSshScript,
  deleteStoredIntegrationCertFiles,
  getTakSshConfig,
  createTakClientCertForIntegration,
};
