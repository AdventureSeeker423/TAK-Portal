"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client, utils: sshUtils } = require("ssh2");
const { getString, getInt, getBool } = require("./env");
const takSshSvc = require("./takSsh.service");
const settingsSvc = require("./settings.service");

const DATA_SSH_DIR = path.join(__dirname, "..", "data", "ssh");
const DEFAULT_CLOUDTAK_KEY = path.join(DATA_SSH_DIR, "cloudtak_ssh_ed25519");
const DEFAULT_CLOUDTAK_PUB = `${DEFAULT_CLOUDTAK_KEY}.pub`;

function resolvePathMaybe(p) {
  if (!p || !String(p).trim()) return null;
  const raw = String(p).trim();
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

function shellQuote(str) {
  return `'${String(str || "").replace(/'/g, `'\"'\"'`)}'`;
}

function quoteForSingleQuotedShell(str) {
  return String(str || "").replace(/'/g, "'\"'\"'");
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
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
  return `ssh-rsa ${payload.toString("base64")} ${comment || "tak-portal-cloudtak"}`;
}

function opensshPublicFromPrivate(privateKeyText, passphrase, comment) {
  const label = comment || "tak-portal-cloudtak";
  try {
    const keyObj = crypto.createPrivateKey({
      key: String(privateKeyText || ""),
      format: "pem",
      passphrase: passphrase || undefined,
    });
    const publicKey = crypto.createPublicKey(keyObj);
    const jwk = publicKey.export({ format: "jwk" });
    if (jwk && jwk.kty === "RSA") return buildSshRsaPublicFromJwk(jwk, label);
  } catch (_) {}
  try {
    const parsed = sshUtils.parseKey(String(privateKeyText || ""), passphrase);
    if (parsed instanceof Error) return null;
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!key || typeof key.getPublicSSH !== "function") return null;
    const pub = key.getPublicSSH();
    const asUtf8 = Buffer.isBuffer(pub) ? pub.toString("utf8") : String(pub || "");
    if (/^(ssh-|ecdsa-)/.test(asUtf8)) {
      const parts = asUtf8.trim().split(/\s+/);
      return `${parts[0]} ${parts[1]} ${label}`;
    }
    const type = (key.type && String(key.type)) || "ssh-rsa";
    const b64 = Buffer.isBuffer(pub) ? pub.toString("base64") : Buffer.from(pub).toString("base64");
    return `${type} ${b64} ${label}`;
  } catch (_) {
    return null;
  }
}

function getLocalKeyStatus() {
  const privateKeyPath =
    resolvePathMaybe(getString("CLOUDTAK_SSH_PRIVATE_KEY_PATH", "")) || DEFAULT_CLOUDTAK_KEY;
  const publicKeyPath =
    resolvePathMaybe(getString("CLOUDTAK_SSH_PUBLIC_KEY_PATH", "")) || DEFAULT_CLOUDTAK_PUB;
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

function persistKeyPaths(keyStatus) {
  const current = settingsSvc.getSettings() || {};
  const next = { ...current };
  let changed = false;
  if (String(next.CLOUDTAK_SSH_PRIVATE_KEY_PATH || "") !== keyStatus.privateKeyPath) {
    next.CLOUDTAK_SSH_PRIVATE_KEY_PATH = keyStatus.privateKeyPath;
    changed = true;
  }
  if (String(next.CLOUDTAK_SSH_PUBLIC_KEY_PATH || "") !== keyStatus.publicKeyPath) {
    next.CLOUDTAK_SSH_PUBLIC_KEY_PATH = keyStatus.publicKeyPath;
    changed = true;
  }
  if (changed) settingsSvc.saveSettings(next);
}

function ensureCloudtakSshKeyPair() {
  ensureDir(DATA_SSH_DIR);

  const existingPrivate = readKeyFile(DEFAULT_CLOUDTAK_KEY);
  if (existingPrivate && isUsablePrivateKey(existingPrivate, undefined)) {
    if (!fs.existsSync(DEFAULT_CLOUDTAK_PUB)) {
      const derived = opensshPublicFromPrivate(existingPrivate, undefined, "tak-portal-cloudtak");
      if (derived) {
        fs.writeFileSync(DEFAULT_CLOUDTAK_PUB, `${derived.trim()}\n`, { mode: 0o644 });
      }
    }
    const status = getLocalKeyStatus();
    persistKeyPaths(status);
    return status;
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 4096,
    publicExponent: 0x10001,
  });
  const privatePem = privateKey.export({ format: "pem", type: "pkcs1" });
  fs.writeFileSync(DEFAULT_CLOUDTAK_KEY, String(privatePem), { mode: 0o600 });

  const jwk = publicKey.export({ format: "jwk" });
  const opensshPublic = buildSshRsaPublicFromJwk(jwk, "tak-portal-cloudtak");
  fs.writeFileSync(DEFAULT_CLOUDTAK_PUB, `${String(opensshPublic).trim()}\n`, { mode: 0o644 });

  const verifyPrivate = fs.readFileSync(DEFAULT_CLOUDTAK_KEY, "utf8");
  if (!isUsablePrivateKey(verifyPrivate, undefined)) {
    throw new Error("Generated CloudTAK private key is not parseable by ssh2.");
  }

  const status = getLocalKeyStatus();
  persistKeyPaths(status);
  return status;
}

function readPublicKeyText(keyStatus) {
  const pubPath = path.resolve(process.cwd(), keyStatus.publicKeyPath);
  if (fs.existsSync(pubPath)) {
    const pub = fs.readFileSync(pubPath, "utf8").trim();
    if (pub) return pub;
  }
  const privPath = path.resolve(process.cwd(), keyStatus.privateKeyPath);
  if (fs.existsSync(privPath)) {
    const derived = opensshPublicFromPrivate(fs.readFileSync(privPath, "utf8"), undefined, "tak-portal-cloudtak");
    if (derived) return derived.trim();
  }
  return "";
}

async function onboardWithPassword({ host, port, username, password }) {
  const h = String(host || "").trim();
  const u = String(username || "").trim();
  const p = String(password || "");
  const sshPort = Number.parseInt(String(port || "22"), 10) || 22;

  if (!h) throw new Error("CloudTAK SSH host is required.");
  if (!u) throw new Error("CloudTAK SSH username is required.");
  if (!p) throw new Error("SSH password is required to generate and install the key.");

  const keyStatus = ensureCloudtakSshKeyPair();
  const pubKey = readPublicKeyText(keyStatus);
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
    throw new Error(result.message || "Could not log in with that password to install the SSH key.");
  }

  const current = settingsSvc.getSettings() || {};
  settingsSvc.saveSettings({
    ...current,
    CLOUDTAK_MARKETPLACE_USE_TAK_SSH: "false",
    CLOUDTAK_SSH_HOST: h,
    CLOUDTAK_SSH_PORT: String(sshPort),
    CLOUDTAK_SSH_USER: u,
    CLOUDTAK_SSH_PRIVATE_KEY_PATH: keyStatus.privateKeyPath,
    CLOUDTAK_SSH_PUBLIC_KEY_PATH: keyStatus.publicKeyPath,
  });

  return {
    ok: true,
    keyStatus: getLocalKeyStatus(),
    message: "SSH key generated and installed on the CloudTAK host.",
  };
}

function useTakSsh() {
  return getBool("CLOUDTAK_MARKETPLACE_USE_TAK_SSH", true);
}

function readKeyFile(keyPath) {
  if (!keyPath || !fs.existsSync(keyPath)) return null;
  try {
    return fs.readFileSync(keyPath, "utf8");
  } catch (_) {
    return null;
  }
}

/**
 * @returns {{ host: string, port: number, username: string, privateKey: string, passphrase?: string, readyTimeout: number, source: string } | null}
 */
function getConnectConfig() {
  const tak = takSshSvc.getTakSshConfig();

  if (useTakSsh()) {
    if (!tak) return null;
    return {
      host: tak.host,
      port: tak.port,
      username: tak.username,
      privateKey: tak.privateKey,
      passphrase: tak.passphrase,
      readyTimeout: 15000,
      source: "tak",
    };
  }

  const host = String(getString("CLOUDTAK_SSH_HOST", "")).trim();
  const username = String(getString("CLOUDTAK_SSH_USER", "")).trim();
  if (!host || !username) return null;

  const port = getInt("CLOUDTAK_SSH_PORT", 22) || 22;
  const keyPath =
    resolvePathMaybe(getString("CLOUDTAK_SSH_PRIVATE_KEY_PATH", "")) || DEFAULT_CLOUDTAK_KEY;
  let privateKey = readKeyFile(keyPath);
  let passphrase = getString("CLOUDTAK_SSH_PASSPHRASE", "").trim() || undefined;

  if (!privateKey && tak) {
    privateKey = tak.privateKey;
    passphrase = tak.passphrase;
  }
  if (!privateKey) return null;

  return {
    host,
    port,
    username,
    privateKey,
    passphrase,
    readyTimeout: 15000,
    source: "cloudtak",
    keyPath,
  };
}

function sshStatus() {
  const usingTak = useTakSsh();
  const tak = takSshSvc.getTakSshConfig();
  const cfg = getConnectConfig();
  const dedicatedKeyPath =
    resolvePathMaybe(getString("CLOUDTAK_SSH_PRIVATE_KEY_PATH", "")) || DEFAULT_CLOUDTAK_KEY;
  return {
    useTakSsh: usingTak,
    configured: !!cfg,
    source: cfg ? cfg.source : usingTak ? "tak" : "cloudtak",
    host: cfg ? cfg.host : usingTak ? "" : String(getString("CLOUDTAK_SSH_HOST", "")).trim(),
    port: cfg ? cfg.port : getInt("CLOUDTAK_SSH_PORT", 22) || 22,
    username: cfg ? cfg.username : String(getString("CLOUDTAK_SSH_USER", "")).trim(),
    takConfigured: !!tak,
    hasDedicatedKey: !!(dedicatedKeyPath && fs.existsSync(dedicatedKeyPath)),
    hasKeyPair: getLocalKeyStatus().hasKeyPair,
    checkoutPath: String(getString("CLOUDTAK_MARKETPLACE_PATH", "")).trim(),
    composeService: String(getString("CLOUDTAK_MARKETPLACE_COMPOSE_SERVICE", "")).trim(),
  };
}

let activeAbort = null;

function abortActiveCommand() {
  const abort = activeAbort;
  activeAbort = null;
  if (!abort) return false;
  try {
    abort();
  } catch (_) {}
  return true;
}

function sendRemoteInterrupt(stream, signalName) {
  if (!stream) return;
  try {
    if (signalName === "INT" && typeof stream.write === "function") stream.write("\x03");
  } catch (_) {}
  try {
    if (typeof stream.signal === "function") stream.signal(signalName);
  } catch (_) {}
}

function stripAnsi(text) {
  return String(text || "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b[()]./g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

function feedPtyChunk(hold, chunk) {
  let all = String(hold || "") + String(chunk || "");
  all = all.replace(/\r\n/g, "\n");
  const lines = [];
  let current = "";
  for (let i = 0; i < all.length; i++) {
    const ch = all[i];
    if (ch === "\n") {
      const cleaned = stripAnsi(current).replace(/\s+$/, "");
      if (cleaned) lines.push(cleaned);
      current = "";
    } else if (ch === "\r") {
      current = "";
    } else {
      current += ch;
    }
  }
  return { lines, hold: current };
}

function execOverSsh(connectConfig, command, timeoutMs = 30000, onChunk) {
  return new Promise((resolve) => {
    const conn = new Client();
    let finished = false;
    let cancelled = false;
    let stream = null;
    const timers = [];
    const later = (ms, fn) => {
      const id = setTimeout(fn, ms);
      timers.push(id);
      return id;
    };
    const clearTimers = () => {
      while (timers.length) clearTimeout(timers.pop());
    };
    const cancelledPayload = () => ({
      ok: false,
      cancelled: true,
      message: "Cancelled.",
      stdout: "",
      stderr: "",
      exitCode: null,
    });
    const done = (payload) => {
      if (finished) return;
      finished = true;
      if (activeAbort === abort) activeAbort = null;
      clearTimeout(t);
      clearTimers();
      try {
        if (cancelled) conn.destroy();
        else conn.end();
      } catch (_) {}
      resolve(payload);
    };
    const abort = () => {
      if (finished) return;
      cancelled = true;
      sendRemoteInterrupt(stream, "INT");
      if (!stream) {
        done(cancelledPayload());
        return;
      }
      later(800, () => {
        if (finished) return;
        sendRemoteInterrupt(stream, "TERM");
        later(800, () => {
          if (finished) return;
          sendRemoteInterrupt(stream, "KILL");
          done(cancelledPayload());
        });
      });
    };
    activeAbort = abort;

    const t = setTimeout(() => {
      done({
        ok: false,
        message: "SSH command timed out.",
        stdout: "",
        stderr: "",
        exitCode: null,
      });
    }, timeoutMs);

    const emit = (text) => {
      if (!onChunk || !text) return;
      const raw = stripAnsi(text).replace(/\s+$/, "");
      if (raw) onChunk(raw);
    };

    const connectOpts = {
      host: connectConfig.host,
      port: connectConfig.port,
      username: connectConfig.username,
      readyTimeout: connectConfig.readyTimeout || 15000,
    };
    if (connectConfig.privateKey) {
      connectOpts.privateKey = connectConfig.privateKey;
      if (connectConfig.passphrase) connectOpts.passphrase = connectConfig.passphrase;
    }
    if (connectConfig.password) {
      connectOpts.password = connectConfig.password;
      connectOpts.tryKeyboard = true;
    }

    conn
      .on("keyboard-interactive", (name, instructions, instructionsLang, prompts, finish) => {
        if (connectConfig && connectConfig.password) {
          finish([String(connectConfig.password)]);
          return;
        }
        finish([]);
      })
      .on("ready", () => {
        if (cancelled) {
          done(cancelledPayload());
          return;
        }
        conn.exec(command, { pty: { term: "xterm", cols: 120, rows: 32 } }, (err, strm) => {
          if (err) {
            done({
              ok: false,
              message: err.message || String(err),
              stdout: "",
              stderr: "",
              exitCode: null,
            });
            return;
          }
          stream = strm;
          if (cancelled) {
            sendRemoteInterrupt(stream, "INT");
            return;
          }
          let stdout = "";
          let stderr = "";
          let stdoutHold = "";
          let stderrHold = "";
          const takeLines = (hold, chunk) => {
            const next = feedPtyChunk(hold, chunk);
            next.lines.forEach((line) => emit(line));
            return next.hold;
          };
          stream.on("data", (data) => {
            const s = data.toString();
            stdout += s;
            stdoutHold = takeLines(stdoutHold, s);
          });
          if (stream.stderr && typeof stream.stderr.on === "function") {
            stream.stderr.on("data", (data) => {
              const s = data.toString();
              stderr += s;
              stderrHold = takeLines(stderrHold, s);
            });
          }
          stream.on("close", (code) => {
            emit(stripAnsi(stdoutHold).replace(/\s+$/, ""));
            emit(stripAnsi(stderrHold).replace(/\s+$/, ""));
            if (cancelled) {
              done(cancelledPayload());
              return;
            }
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
        if (cancelled) return;
        done({
          ok: false,
          message: err.message || String(err),
          stdout: "",
          stderr: "",
          exitCode: null,
        });
      })
      .connect(connectOpts);
  });
}

async function runCommand(command, timeoutMs = 30000, onChunk) {
  const raw = String(command || "").trim();
  if (!raw) {
    return { ok: false, message: "Command is required.", stdout: "", stderr: "", exitCode: null };
  }
  const cfg = getConnectConfig();
  if (!cfg) {
    return {
      ok: false,
      message: useTakSsh()
        ? "TAK Server SSH is not configured. Complete SSH setup under Connection & Certificates."
        : "CloudTAK SSH is not configured. Enter host, user, and password, then generate and install a key.",
      stdout: "",
      stderr: "",
      exitCode: null,
    };
  }
  return execOverSsh(cfg, raw, timeoutMs, onChunk);
}

function detectScript() {
  return `
set -eu
is_ct() {
  [ -n "\$1" ] && [ -d "\$1/api" ]
}
consider() {
  local d="\$1"
  [ -n "\$d" ] || return 1
  d=\${d%/}
  if is_ct "\$d"; then
    found="\$d"
    return 0
  fi
  return 1
}
found=""
if [ -n "\${CLOUDTAK:-}" ]; then consider "\$CLOUDTAK" || true; fi
for d in \\
  "\$HOME/CloudTAK" "\$HOME/cloudtak" "\$HOME/src/CloudTAK" "\$HOME/git/CloudTAK" "\$HOME/apps/CloudTAK" \\
  /home/takwerx/CloudTAK /home/tak/CloudTAK /opt/CloudTAK /opt/cloudtak \\
  /root/CloudTAK /root/cloudtak /usr/local/CloudTAK /var/lib/CloudTAK
do
  [ -z "\$found" ] || break
  consider "\$d" || true
done
if [ -z "\$found" ]; then
  for d in /home/*/CloudTAK /home/*/cloudtak /opt/*/CloudTAK; do
    [ -z "\$found" ] || break
    consider "\$d" || true
  done
fi
if [ -z "\$found" ]; then
  while IFS= read -r d; do
    [ -n "\$d" ] || continue
    case "\$d" in
      */api/web/plugins)
        consider "\$(dirname "\$(dirname "\$(dirname "\$d")")")" && break
        ;;
      *)
        consider "\$d" && break
        ;;
    esac
  done <<EOF
\$(find /home /opt /root /usr/local /var/lib -maxdepth 5 -type d \\( -iname CloudTAK -o -path '*/api/web/plugins' \\) 2>/dev/null | head -n 40 || true)
EOF
fi
if [ -z "\$found" ] && command -v docker >/dev/null 2>&1; then
  while IFS= read -r c; do
    [ -n "\$c" ] || continue
    echo "\$c" | grep -qiE 'cloudtak|takwerx' || continue
    while IFS=\$'\\t' read -r src dest; do
      [ -n "\${src:-}" ] || continue
      case "\$src" in
        *[Cc]loud[Tt][Aa][Kk]*) consider "\$src" && break 2 ;;
      esac
      case "\$dest" in
        */api/web/plugins|*/web/plugins)
          consider "\$src" && break 2
          consider "\$(dirname "\$src")" && break 2
          consider "\$(dirname "\$(dirname "\$src")")" && break 2
          ;;
        */api)
          consider "\$(dirname "\$src")" && break 2
          ;;
      esac
    done <<MOUNTS
\$(docker inspect -f '{{range .Mounts}}{{.Source}}	{{.Destination}}{{println}}{{end}}' "\$c" 2>/dev/null || true)
MOUNTS
  done <<CONTAINERS
\$(docker ps --format '{{.Names}}' 2>/dev/null || true)
CONTAINERS
fi
if [ -z "\$found" ]; then
  echo "DETECT_FAIL no CloudTAK checkout with api/"
  exit 1
fi
compose=""
svc=""
if [ -f "\$found/docker-compose.yml" ]; then compose="docker-compose.yml"
elif [ -f "\$found/docker-compose.yaml" ]; then compose="docker-compose.yaml"
elif [ -f "\$found/compose.yml" ]; then compose="compose.yml"
elif [ -f "\$found/compose.yaml" ]; then compose="compose.yaml"
fi
if [ -n "\$compose" ]; then
  cf="\$found/\$compose"
  if grep -Eq '^[[:space:]]*cloudtak-api:' "\$cf"; then svc="cloudtak-api"
  elif grep -Eq '^[[:space:]]*api:' "\$cf"; then svc="api"
  elif grep -q 'build:[[:space:]]*\\./api' "\$cf"; then
    svc=$(awk '
      /^[[:space:]]*[A-Za-z0-9._-]+:[[:space:]]*$/ { cur=$1; sub(":","",cur) }
      /build:[[:space:]]*\\.\\/api/ { print cur; exit }
    ' "\$cf")
  fi
fi
printf 'DETECT_OK path=%s compose=%s service=%s\\n' "\$found" "\$compose" "\${svc:-api}"
`.trim();
}

async function detectCheckout() {
  const result = await runCommand(`bash -lc ${shellQuote(detectScript())}`, 40000);
  if (!result.ok) return result;
  const line = String(result.stdout || "")
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s.startsWith("DETECT_OK"));
  if (!line) {
    return { ok: false, message: result.stdout || result.message || "Detect failed." };
  }
  const pathMatch = line.match(/path=(\S+)/);
  const composeMatch = line.match(/compose=(\S+)/);
  const svcMatch = line.match(/service=(\S+)/);
  return {
    ok: true,
    path: pathMatch ? pathMatch[1] : "",
    composeFile: composeMatch && composeMatch[1] !== "" ? composeMatch[1] : "",
    composeService: svcMatch ? svcMatch[1] : "api",
    stdout: result.stdout,
  };
}

async function testConnection() {
  const cfg = getConnectConfig();
  if (!cfg) {
    return {
      ok: false,
      message: useTakSsh()
        ? "TAK Server SSH is not configured. Complete SSH setup under Connection & Certificates."
        : "CloudTAK SSH is not configured. Enter host, user, and password, then generate and install a key.",
    };
  }
  const uname = await runCommand("uname -s && whoami && echo HOST:$(hostname)", 15000);
  if (!uname.ok) {
    return {
      ok: false,
      message: uname.message || "SSH failed.",
      host: cfg.host,
      source: cfg.source,
    };
  }
  const override = String(getString("CLOUDTAK_MARKETPLACE_PATH", "")).trim();
  let detected = null;
  if (override) {
    const check = await runCommand(
      `test -d ${shellQuote(override + "/api")} && echo PATH_OK || echo PATH_MISSING`,
      15000
    );
    const okPath = String(check.stdout || "").includes("PATH_OK");
    detected = {
      path: override,
      composeService: String(getString("CLOUDTAK_MARKETPLACE_COMPOSE_SERVICE", "")).trim() || "api",
      pathOk: okPath,
    };
    if (!okPath) {
      return {
        ok: false,
        message: `Connected, but CloudTAK path ${override} has no api/ directory.`,
        host: cfg.host,
        username: cfg.username,
        source: cfg.source,
        uname: String(uname.stdout || "").trim(),
        detected,
      };
    }
  } else {
    detected = await detectCheckout();
    if (!detected.ok) {
      return {
        ok: false,
        message: `Connected, but could not find a CloudTAK checkout: ${detected.message || "not found"}`,
        host: cfg.host,
        username: cfg.username,
        source: cfg.source,
        uname: String(uname.stdout || "").trim(),
      };
    }
  }
  return {
    ok: true,
    message: "SSH connected.",
    host: cfg.host,
    username: cfg.username,
    source: cfg.source,
    uname: String(uname.stdout || "").trim(),
    path: detected.path,
    composeService:
      String(getString("CLOUDTAK_MARKETPLACE_COMPOSE_SERVICE", "")).trim() ||
      detected.composeService ||
      "api",
    composeFile: detected.composeFile || "",
  };
}

function resolvedCheckoutPath() {
  return String(getString("CLOUDTAK_MARKETPLACE_PATH", "")).trim();
}

function resolvedComposeService() {
  return String(getString("CLOUDTAK_MARKETPLACE_COMPOSE_SERVICE", "")).trim() || "api";
}

module.exports = {
  DEFAULT_CLOUDTAK_KEY,
  DEFAULT_CLOUDTAK_PUB,
  useTakSsh,
  getConnectConfig,
  sshStatus,
  getLocalKeyStatus,
  ensureCloudtakSshKeyPair,
  onboardWithPassword,
  runCommand,
  abortActiveCommand,
  sendRemoteInterrupt,
  stripAnsi,
  feedPtyChunk,
  detectCheckout,
  testConnection,
  shellQuote,
  resolvedCheckoutPath,
  resolvedComposeService,
};
