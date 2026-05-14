/**
 * services/takSsh.service.js
 *
 * Run makeCert.sh on the TAK server via SSH when creating an integration user.
 * Used so that nodered-* integration users get a client cert on the TAK server.
 *
 * Settings (all optional; if not set, cert creation is skipped):
 *   TAK_SSH_HOST       SSH host (default: hostname from TAK_URL)
 *   TAK_SSH_PORT       SSH port (default: 22)
 *   TAK_SSH_USER       SSH username (must be able to sudo -u tak)
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
    "sudo -u tak bash -lc 'set -e; cd /opt/tak/certs; " +
    `name='${safeName}'; ` +
    "pem=''; key=''; p12path=''; " +
    "for p in \"./files/${name}.pem\" \"./${name}.pem\" \"/opt/tak/certs/files/${name}.pem\" \"/opt/tak/certs/${name}.pem\"; do [ -f \"$p\" ] && pem=\"$p\" && break; done; " +
    "for k in \"./files/${name}.key\" \"./${name}.key\" \"/opt/tak/certs/files/${name}.key\" \"/opt/tak/certs/${name}.key\"; do [ -f \"$k\" ] && key=\"$k\" && break; done; " +
    "for f in \"./files/${name}.p12\" \"./${name}.p12\" \"/opt/tak/certs/files/${name}.p12\" \"/opt/tak/certs/${name}.p12\"; do [ -f \"$f\" ] && p12path=\"$f\" && break; done; " +
    "if [ -z \"$pem\" ] || [ -z \"$key\" ]; then echo \"Missing cert files for ${name}\" 1>&2; exit 44; fi; " +
    "echo __TAK_CERT_PEM_BEGIN__; base64 \"$pem\" | tr -d \"\\n\"; echo; echo __TAK_CERT_PEM_END__; " +
    "echo __TAK_CERT_KEY_BEGIN__; base64 \"$key\" | tr -d \"\\n\"; echo; echo __TAK_CERT_KEY_END__; " +
    "if [ -n \"$p12path\" ]; then echo __TAK_CERT_P12_BEGIN__; base64 \"$p12path\" | tr -d \"\\n\"; echo; echo __TAK_CERT_P12_END__; fi'";

  const result = await execOverSsh(
    {
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      privateKey: cfg.privateKey,
      passphrase: cfg.passphrase,
      readyTimeout: 15000,
    },
    remoteScript
  );

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
  const revokeCommand =
    "sudo -u tak bash -lc 'set -e; cd /opt/tak/certs; " +
    `./revokeCert.sh files/${safeName} files/ca-do-not-share files/ca'`;

  const result = await execOverSsh(
    {
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      privateKey: cfg.privateKey,
      passphrase: cfg.passphrase,
      readyTimeout: 15000,
    },
    revokeCommand,
    45000
  );

  if (!result.ok) {
    throw new Error(result.message || "Failed to revoke integration cert via SSH script.");
  }

  // Cleanup integration certificate artifacts after revoke.
  // We intentionally ignore "file not found" outcomes so cleanup is idempotent.
  const cleanupCommand =
    "sudo -u tak bash -lc 'set -e; cd /opt/tak/certs; " +
    `name='${safeName}'; ` +
    "for ext in csr jks key p12 pem; do " +
    "rm -f \"./files/${name}.${ext}\" \"./${name}.${ext}\"; " +
    "done; " +
    "rm -f \"./files/${name}-trusted.pem\" \"./${name}-trusted.pem\"'";

  const cleanupResult = await execOverSsh(
    {
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      privateKey: cfg.privateKey,
      passphrase: cfg.passphrase,
      readyTimeout: 15000,
    },
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
  const safePath = quoteForSingleQuotedShell(p);
  const cmd = `sudo tee '${safePath}' > /dev/null`;
  return execOverSshWithStdin(
    {
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      privateKey: cfg.privateKey,
      passphrase: cfg.passphrase,
      readyTimeout: 15000,
    },
    cmd,
    contentUtf8,
    180000
  );
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

  const current = settingsSvc.getSettings() || {};
  settingsSvc.saveSettings({
    ...current,
    TAK_SSH_HOST: h,
    TAK_SSH_PORT: String(sshPort),
    TAK_SSH_USER: u,
    TAK_SSH_ONBOARDED: "true",
    TAK_SSH_LAST_HANDSHAKE_AT: new Date().toISOString(),
    TAK_SSH_PRIVATE_KEY_PATH: keyStatus.privateKeyPath,
    TAK_SSH_PUBLIC_KEY_PATH: keyStatus.publicKeyPath,
  });

  return {
    ok: true,
    keyStatus: getLocalKeyStatus(),
    message: "SSH key installed on remote server. Handshake complete.",
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
        conn.exec("sudo reboot", (err, stream) => {
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
        host: cfg.host,
        port: cfg.port,
        username: cfg.username,
        privateKey: cfg.privateKey,
        passphrase: cfg.passphrase,
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
 * Run on TAK server: sudo -u tak bash -c 'cd /opt/tak/certs && ./makeCert.sh client <username>'
 * @param {string} username - Integration username (e.g. nodered-aircraft-all)
 * @returns { Promise<{ ok: boolean, skipped?: boolean, message?: string }> }
 */
function createTakClientCertForIntegration(username) {
  const TAK_DEBUG = getBool("TAK_DEBUG", false);
  const bypass = getBool("TAK_BYPASS_ENABLED", false);
  if (bypass) {
    return Promise.resolve({ ok: false, skipped: true, message: "TAK bypass enabled." });
  }

  const un = String(username || "").trim();
  if (!un) return Promise.resolve({ ok: false, message: "Username required." });

  const config = getTakSshConfig();
  if (!config) {
    return Promise.resolve({
      ok: false,
      skipped: true,
      message: "TAK SSH not configured (set TAK_SSH_USER and TAK_SSH_PRIVATE_KEY_PATH).",
    });
  }

  // Safe for shell: single-quote wrapped; username is alphanumeric + hyphens only for integrations
  const safeName = un.replace(/'/g, "'\"'\"'");
  const command = `sudo -u tak bash -c 'cd /opt/tak/certs && ./makeCert.sh client ${safeName}'`;

  if (TAK_DEBUG) console.log("[TAK SSH] Connecting to", config.host + ":" + config.port, "as", config.username);

  return execOverSsh(
    {
      host: config.host,
      port: config.port,
      username: config.username,
      privateKey: config.privateKey,
      passphrase: config.passphrase,
      readyTimeout: 15000,
    },
    command
  ).then((result) => {
    if (!result.ok) return { ok: false, message: result.message };
    if (TAK_DEBUG) console.log("[TAK SSH] makeCert.sh succeeded for", un);
    return { ok: true };
  });
}

module.exports = {
  getLocalKeyStatus,
  ensureLocalSshKeyPair,
  onboardTakSshWithPassword,
  runRemoteSshCommand,
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
