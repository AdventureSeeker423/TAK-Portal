"use strict";

const fs = require("fs");
const path = require("path");
const { Client } = require("ssh2");
const { getString, getInt, getBool } = require("./env");
const takSshSvc = require("./takSsh.service");

const DEFAULT_CLOUDTAK_KEY = path.join(__dirname, "..", "data", "ssh", "cloudtak_ssh_ed25519");

function resolvePathMaybe(p) {
  if (!p || !String(p).trim()) return null;
  const raw = String(p).trim();
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

function shellQuote(str) {
  return `'${String(str || "").replace(/'/g, `'\"'\"'`)}'`;
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
    checkoutPath: String(getString("CLOUDTAK_MARKETPLACE_PATH", "")).trim(),
    composeService: String(getString("CLOUDTAK_MARKETPLACE_COMPOSE_SERVICE", "")).trim(),
  };
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
      done({
        ok: false,
        message: "SSH command timed out.",
        stdout: "",
        stderr: "",
        exitCode: null,
      });
    }, timeoutMs);

    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
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
        done({
          ok: false,
          message: err.message || String(err),
          stdout: "",
          stderr: "",
          exitCode: null,
        });
      })
      .connect({
        host: connectConfig.host,
        port: connectConfig.port,
        username: connectConfig.username,
        privateKey: connectConfig.privateKey,
        passphrase: connectConfig.passphrase,
        readyTimeout: connectConfig.readyTimeout || 15000,
      });
  });
}

async function runCommand(command, timeoutMs = 30000) {
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
        : "CloudTAK SSH is not configured. Enter host, user, and a key (or reuse the portal TAK SSH key).",
      stdout: "",
      stderr: "",
      exitCode: null,
    };
  }
  return execOverSsh(cfg, raw, timeoutMs);
}

function detectScript() {
  return `
set -eu
found=""
if [ -n "\${CLOUDTAK:-}" ] && [ -d "\$CLOUDTAK/api" ]; then
  found="\$CLOUDTAK"
fi
if [ -z "\$found" ] && [ -d "\$HOME/CloudTAK/api" ]; then
  found="\$HOME/CloudTAK"
fi
if [ -z "\$found" ] && [ -d /home/takwerx/CloudTAK/api ]; then
  found="/home/takwerx/CloudTAK"
fi
if [ -z "\$found" ]; then
  for d in /home/*/CloudTAK; do
    if [ -d "\$d/api" ]; then
      if [ -f "\$d/docker-compose.yml" ] || [ -f "\$d/compose.yml" ] || [ -f "\$d/docker-compose.yaml" ]; then
        found="\$d"
        break
      fi
      if [ -z "\$found" ]; then found="\$d"; fi
    fi
  done
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
  const result = await runCommand(`bash -lc ${shellQuote(detectScript())}`, 20000);
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
        : "CloudTAK SSH is not configured. Enter host, user, and a key.",
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
  useTakSsh,
  getConnectConfig,
  sshStatus,
  runCommand,
  detectCheckout,
  testConnection,
  shellQuote,
  resolvedCheckoutPath,
  resolvedComposeService,
};
