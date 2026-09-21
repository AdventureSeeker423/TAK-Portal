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

function execOverSsh(connectConfig, command, timeoutMs = 30000, onChunk) {
  return new Promise((resolve) => {
    const conn = new Client();
    let finished = false;
    let cancelled = false;
    const done = (payload) => {
      if (finished) return;
      finished = true;
      if (activeAbort === abort) activeAbort = null;
      clearTimeout(t);
      try {
        if (cancelled) conn.destroy();
        else conn.end();
      } catch (_) {}
      resolve(payload);
    };
    const abort = () => {
      cancelled = true;
      done({
        ok: false,
        cancelled: true,
        message: "Cancelled.",
        stdout: "",
        stderr: "",
        exitCode: null,
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
      String(text)
        .split(/\r\n|\n|\r/)
        .forEach((line) => {
          const raw = String(line || "").replace(/\s+$/, "");
          if (raw) onChunk(raw);
        });
    };

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
          let stdoutHold = "";
          let stderrHold = "";
          const takeLines = (hold, chunk) => {
            const all = hold + chunk;
            const parts = all.split(/\r\n|\n|\r/);
            const rest = parts.pop() || "";
            parts.forEach((line) => emit(line));
            return rest;
          };
          stream.on("data", (data) => {
            const s = data.toString();
            stdout += s;
            stdoutHold = takeLines(stdoutHold, s);
          });
          stream.stderr.on("data", (data) => {
            const s = data.toString();
            stderr += s;
            stderrHold = takeLines(stderrHold, s);
          });
          stream.on("close", (code) => {
            emit(stdoutHold);
            emit(stderrHold);
            if (cancelled) return;
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
        : "CloudTAK SSH is not configured. Enter host, user, and a key (or reuse the portal TAK SSH key).",
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
  abortActiveCommand,
  detectCheckout,
  testConnection,
  shellQuote,
  resolvedCheckoutPath,
  resolvedComposeService,
};
