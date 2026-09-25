"use strict";

const DIRECTIVE_HEADER =
  /^(route|handle|handle_path|handle_errors|redir|respond|reverse_proxy|forward_auth|basicauth|request_body|import|encode|header|uri|rewrite|root|file_server|php_fastcgi|log|tls|bind|metrics|map|vars)\b/;

function actionKey(action) {
  return [action && action.kind, action && action.title, action && action.snippet].join("\0");
}

function isOptionalAction(action) {
  const title = String((action && action.title) || "");
  const text = String((action && action.text) || "");
  return /^optional\b/i.test(title) || /^optional\b/i.test(text);
}

function isCaddyAction(action) {
  const snippet = String((action && action.snippet) || "").trim();
  if (!snippet) return false;
  const kind = String((action && action.kind) || "");
  if (/\b(csp|connect-src|img-src|nginx)\b/i.test(kind)) return false;
  if (/^\([A-Za-z0-9_-]+\)\s*\{/.test(snippet)) return true;
  if (/(^|\n)\s*(handle_path|handle|route|reverse_proxy|import)\b/.test(snippet)) return true;
  return false;
}

function squash(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function listBlocks(text) {
  const blocks = [];
  const stack = [];
  let i = 0;
  let headerStart = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === '"' || c === "`") {
      const q = c;
      i += 1;
      while (i < text.length && text[i] !== q) {
        if (text[i] === "\\") i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === "<" && text[i + 1] === "<") {
      const next = skipHeredoc(text, i);
      if (next > i) {
        i = next;
        continue;
      }
    }
    if (c === "\n") {
      headerStart = i + 1;
      i += 1;
      continue;
    }
    if (c === "{") {
      stack.push({ header: text.slice(headerStart, i).trim(), open: i, depth: stack.length });
      headerStart = i + 1;
      i += 1;
      continue;
    }
    if (c === "}") {
      const open = stack.pop();
      if (open) blocks.push({ ...open, close: i });
      headerStart = i + 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return blocks;
}

function isSiteHeader(header) {
  const value = String(header || "").trim();
  if (!value) return false;
  if (value.startsWith("(") || value.startsWith("@")) return false;
  const first = value.split(/\s+/)[0];
  if (/[.:]/.test(first) || /^https?:\/\//i.test(first)) return true;
  if (DIRECTIVE_HEADER.test(value)) return false;
  return true;
}

function skipHeredoc(text, i) {
  const match = text.slice(i).match(/^<<-?\s*["']?([A-Za-z0-9_]+)["']?/);
  if (!match) return i;
  const marker = match[1];
  const after = i + match[0].length;
  const end = text.slice(after).search(new RegExp(`(?:^|\\n)[ \\t]*${marker}(?=\\s|$)`));
  if (end < 0) return text.length;
  return after + end + text.slice(after + end).indexOf(marker) + marker.length;
}

function isCloudtakProxyLine(line) {
  if (/^\s*#/.test(line)) return false;
  if (!/\breverse_proxy\b/.test(line)) return false;
  return /\bcloudtak[-_]?api\b/i.test(line) || /\bcloudtak\b/i.test(line);
}

function siteHosts(header) {
  return String(header || "")
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/^https?:\/\//i, "").replace(/:\d+$/, "").replace(/\.$/, "").toLowerCase())
    .filter((part) => part.includes("."));
}

function commentsAbove(text, block) {
  const lines = text.slice(0, block.open).split("\n");
  const collected = [];
  let skippedHeader = false;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!skippedHeader) {
      skippedHeader = true;
      if (!line.startsWith("#")) continue;
    }
    if (!line) {
      if (collected.length) break;
      continue;
    }
    if (!line.startsWith("#")) break;
    collected.push(line);
  }
  return collected.join("\n");
}

function cloudtakCommentScore(comment) {
  if (!/\bcloudtak\b/i.test(comment)) return 0;
  if (/\bweb ui\b/i.test(comment)) return 80;
  if (/\b(tile|tiles|media|video)\b/i.test(comment)) return 0;
  return 50;
}

function findCloudtakSite(text, options = {}) {
  const blocks = listBlocks(text);
  const sites = blocks.filter((b) => b.depth === 0 && isSiteHeader(b.header));
  const wantHost = String((options && options.host) || "").trim().toLowerCase();
  const scored = sites
    .map((block) => {
      const body = text.slice(block.open, block.close);
      const hosts = siteHosts(block.header);
      let score = 0;
      if (body.split("\n").some(isCloudtakProxyLine)) score += 100;
      if (wantHost && hosts.includes(wantHost)) score += 90;
      score += cloudtakCommentScore(commentsAbove(text, block));
      if (hosts.some((host) => host.startsWith("map.")) && /\breverse_proxy\b/.test(body)) score += 30;
      return { block, score };
    })
    .filter((row) => row.score > 0);
  if (scored.length) {
    scored.sort((a, b) => b.score - a.score || a.block.open - b.block.open);
    return { block: scored[0].block, assumed: scored[0].score < 50 };
  }
  if (sites.length === 1) return { block: sites[0], assumed: true };
  return null;
}

function lineIndent(line) {
  const match = String(line || "").match(/^[ \t]*/);
  return match ? match[0] : "";
}

function reindent(snippet, baseIndent) {
  const lines = String(snippet || "").replace(/\r\n/g, "\n").split("\n");
  const depths = lines.filter((line) => line.trim()).map((line) => {
    const raw = line.match(/^[ \t]*/)[0];
    const tabs = (raw.match(/\t/g) || []).length;
    const spaces = (raw.match(/ /g) || []).length;
    return tabs + Math.floor(spaces / 2);
  });
  const min = depths.length ? Math.min(...depths) : 0;
  const unit = baseIndent.includes("\t") || !baseIndent ? "\t" : "  ";
  return lines
    .map((line) => {
      if (!line.trim()) return "";
      const raw = line.match(/^[ \t]*/)[0];
      const tabs = (raw.match(/\t/g) || []).length;
      const spaces = (raw.match(/ /g) || []).length;
      const depth = tabs + Math.floor(spaces / 2);
      return baseIndent + unit.repeat(Math.max(0, depth - min)) + line.trim();
    })
    .join("\n");
}

function insertionPoint(text, block) {
  const bodyStart = block.open + 1;
  const body = text.slice(bodyStart, block.close);
  const lines = body.split("\n");
  let chosen = -1;
  let proxy = -1;
  lines.forEach((line, index) => {
    if (chosen < 0 && isCloudtakProxyLine(line)) chosen = index;
    if (proxy < 0 && /^\s*reverse_proxy\b/.test(line) && !/^\s*#/.test(line)) proxy = index;
  });
  const index = chosen >= 0 ? chosen : proxy;
  if (index < 0) {
    const indent = lines.map(lineIndent).find((value) => value) || "\t";
    return { at: bodyStart, indent, atStart: true };
  }
  let at = bodyStart;
  for (let i = 0; i < index; i += 1) at += lines[i].length + 1;
  return { at, indent: lineIndent(lines[index]), atStart: false };
}

function insertAt(text, index, block) {
  const needsLead = index > 0 && text[index - 1] !== "\n" ? "\n" : "";
  const needsTrail = text[index] !== "\n" ? "\n" : "";
  return text.slice(0, index) + needsLead + block + needsTrail + text.slice(index);
}

function namedSnippet(snippet) {
  const match = String(snippet || "").trim().match(/^\(([A-Za-z0-9_-]+)\)\s*\{/);
  return match ? match[1] : "";
}

function blockHasImport(text, block, name) {
  const body = text.slice(block.open, block.close);
  return new RegExp(`(^|\\n)\\s*import\\s+${name}\\b`).test(body);
}

function definitionPresent(text, snippet) {
  return squash(text).includes(squash(snippet));
}

const USER_ADDED_MARKER = [
  "# --- User-added blocks (do not remove) ---",
  "# Anything below this line survives every infra-TAK regeneration.",
  "# Add custom site blocks here (extra domains, redirects, monitors).",
];

function userAddedInsertAt(text) {
  const lines = String(text || "").split("\n");
  for (let i = 0; i <= lines.length - USER_ADDED_MARKER.length; i += 1) {
    if (!USER_ADDED_MARKER.every((line, offset) => lines[i + offset].trim() === line)) continue;
    const last = i + USER_ADDED_MARKER.length - 1;
    let at = 0;
    for (let j = 0; j <= last; j += 1) {
      at += lines[j].length;
      if (j < lines.length - 1 || text.endsWith("\n")) at += 1;
    }
    return Math.min(at, text.length);
  }
  return null;
}

function topLevelSnippetBlock(text, name) {
  return listBlocks(text).find((block) => block.depth === 0 && block.header.replace(/\s/g, "") === `(${name})`) || null;
}

function removeTopLevelSnippet(text, name) {
  const block = topLevelSnippetBlock(text, name);
  if (!block) return text;
  const lineStart = text.lastIndexOf("\n", Math.max(0, block.open - 1)) + 1;
  let end = block.close + 1;
  if (text[end] === "\n") end += 1;
  return text.slice(0, lineStart) + text.slice(end);
}

function lineStart(text, index) {
  return text.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
}

function namedSnippetDestination(text, options) {
  const site = findCloudtakSite(text, options);
  const siteAt = site ? lineStart(text, site.block.open) : text.length;
  const markerAt = userAddedInsertAt(text);
  if (markerAt != null && markerAt <= siteAt) return { at: markerAt, siteAt, markerAt };
  return { at: siteAt, siteAt, markerAt };
}

function snippetSitsLegally(block, dest) {
  if (!block) return false;
  if (block.open >= dest.siteAt) return false;
  if (dest.markerAt != null && dest.markerAt <= dest.siteAt && block.open < dest.markerAt) return false;
  return true;
}

function placeNamedSnippet(text, snippet, name, options) {
  const body = String(snippet || "").trim() + "\n";
  let dest = namedSnippetDestination(text, options);
  const block = topLevelSnippetBlock(text, name);
  if (snippetSitsLegally(block, dest)) return { text, did: false };
  if (block) text = removeTopLevelSnippet(text, name);
  dest = namedSnippetDestination(text, options);
  return { text: insertAt(text, dest.at, body), did: true };
}

function applyCaddySnippets(source, snippets, options = {}) {
  let text = String(source || "").replace(/\r\n/g, "\n");
  const changes = [];
  const list = (Array.isArray(snippets) ? snippets : []).map((item) => String(item || "").trim()).filter(Boolean);
  for (const snippet of list) {
    const name = namedSnippet(snippet);
    const site = findCloudtakSite(text, options);
    if (!site) {
      return {
        ok: false,
        changed: false,
        text,
        message: "Caddy is running, but no site block reverse-proxies CloudTAK.",
        changes,
      };
    }
    if (name) {
      let did = false;
      const placed = placeNamedSnippet(text, snippet, name, options);
      text = placed.text;
      did = placed.did;
      const again = findCloudtakSite(text, options);
      if (again && !blockHasImport(text, again.block, name)) {
        const point = insertionPoint(text, again.block);
        text = insertAt(text, point.at, `${point.indent}import ${name}`);
        did = true;
      }
      changes.push({ snippet, status: did ? "inserted" : "present", import: name });
      continue;
    }
    if (definitionPresent(text, snippet)) {
      changes.push({ snippet, status: "present" });
      continue;
    }
    const point = insertionPoint(text, site.block);
    text = insertAt(text, point.at, reindent(snippet, point.indent));
    changes.push({ snippet, status: "inserted" });
  }
  if (text && !text.endsWith("\n")) text += "\n";
  const original = String(source || "").replace(/\r\n/g, "\n");
  const normalized = original.endsWith("\n") || !original ? original : `${original}\n`;
  return { ok: true, changed: text !== normalized, text, changes, message: "" };
}

function snippetIsApplied(source, snippet, options) {
  const result = applyCaddySnippets(source, [snippet], options);
  return !!(result.ok && !result.changed);
}

function appliedKeys(plugins, caddyText, options) {
  const keys = [];
  for (const plugin of Array.isArray(plugins) ? plugins : []) {
    for (const action of (plugin && plugin.additionalActions) || []) {
      if (!isCaddyAction(action)) continue;
      if (snippetIsApplied(caddyText, action.snippet, options)) keys.push(actionKey(action));
    }
  }
  return keys;
}

function extraConfigStatus(actions, caddy) {
  const list = Array.isArray(actions) ? actions : [];
  const required = list.filter((action) => !isOptionalAction(action));
  const applied = new Set((caddy && caddy.applied) || []);
  const caddyActions = list.filter(isCaddyAction);
  const pendingCaddy = caddyActions.filter((action) => !applied.has(actionKey(action)));
  const pendingRequired = required.filter((action) => {
    if (!isCaddyAction(action)) return true;
    return !applied.has(actionKey(action));
  });
  return {
    caddyOnHost: !!(caddy && caddy.available),
    hasCaddyActions: caddyActions.length > 0,
    caddyPending: pendingCaddy.length > 0,
    complete: required.length > 0 && pendingRequired.length === 0,
  };
}

function parseProbe(stdout) {
  const text = String(stdout || "").replace(/\r\n/g, "\n");
  if (!/^CADDY_OK\b/m.test(text)) {
    return { available: false, applied: [], file: "", message: "" };
  }
  const meta = {};
  for (const line of text.split("\n")) {
    if (line === "CADDY_B64_BEGIN") break;
    const match = line.match(/^([A-Za-z]+)=(.*)$/);
    if (match) meta[match[1]] = match[2];
  }
  const encoded = text.match(/CADDY_B64_BEGIN\n([A-Za-z0-9+/=\n]*)\n?CADDY_B64_END/);
  const file = encoded ? Buffer.from(encoded[1].replace(/\s/g, ""), "base64").toString("utf8") : "";
  return {
    available: true,
    via: meta.via || "",
    container: meta.container || "",
    hostPath: meta.hostPath || "",
    containerPath: meta.containerPath || "",
    validateCmd: meta.validate || "",
    reloadCmd: meta.reload || "",
    file,
    applied: [],
    message: meta.message || "",
  };
}

function discoverScript(ctPath) {
  const ct = String(ctPath || "");
  return `
set -u
CT=${JSON.stringify(ct)}
runtime=""
if command -v docker >/dev/null 2>&1; then runtime=docker
elif command -v podman >/dev/null 2>&1; then runtime=podman
fi
best_score=-1
best_via=""
best_container=""
best_host=""
best_container_path=""
best_validate=""
best_reload=""
consider() {
  local score="\$1" via="\$2" container="\$3" host="\$4" cpath="\$5" validate="\$6" reload="\$7"
  [ -n "\$host" ] && [ -f "\$host" ] || return 0
  if grep -Eq 'cloudtak[-_]?api|reverse_proxy[^#]*cloudtak' "\$host" 2>/dev/null; then
    score=\$((score + 100))
  fi
  if [ "\$score" -gt "\$best_score" ]; then
    best_score=\$score
    best_via=\$via
    best_container=\$container
    best_host=\$host
    best_container_path=\$cpath
    best_validate=\$validate
    best_reload=\$reload
  fi
}
running=0
cand=\$(mktemp)
trap 'rm -f "\$cand"' EXIT
if [ -n "\$runtime" ]; then
  ids=\$(\$runtime ps -q 2>/dev/null || true)
  for id in \$ids; do
    [ -n "\$id" ] || continue
    name=\$(\$runtime inspect -f '{{.Name}}' "\$id" 2>/dev/null | sed 's#^/##' || true)
    image=\$(\$runtime inspect -f '{{.Config.Image}}' "\$id" 2>/dev/null || true)
    entry=\$(\$runtime inspect -f '{{json .Config.Entrypoint}}' "\$id" 2>/dev/null || true)
    looks=0
    printf '%s %s' "\$name" "\$image" | grep -qi caddy && looks=1
    mounts=\$(\$runtime inspect -f '{{range .Mounts}}{{.Source}}|{{.Destination}}{{println}}{{end}}' "\$id" 2>/dev/null || true)
    echo "\$mounts" | while IFS= read -r row; do
      [ -n "\$row" ] || continue
      src=\${row%%|*}
      dest=\${row#*|}
      host="\$src"
      case "\$dest" in
        *Caddyfile) ;;
        /etc/caddy|/etc/caddy/) host="\$src/Caddyfile" ;;
        *) continue ;;
      esac
      if [ "\$looks" -ne 1 ]; then
        printf '%s' "\$dest" | grep -qi caddy || continue
      fi
      echo "\$host|\$dest|\$name|\$entry"
    done >> "\$cand"
  done
  while IFS='|' read -r host dest name entry; do
    [ -n "\$host" ] || continue
    running=1
    if printf '%s' "\$entry" | grep -Eq 'caddy'; then
      vcmd="\$runtime exec \$name validate --config \$dest --adapter caddyfile"
      rcmd="\$runtime exec \$name reload --config \$dest --adapter caddyfile"
    else
      vcmd="\$runtime exec \$name caddy validate --config \$dest --adapter caddyfile"
      rcmd="\$runtime exec \$name caddy reload --config \$dest --adapter caddyfile"
    fi
    consider 40 docker "\$name" "\$host" "\$dest" "\$vcmd" "\$rcmd"
  done < "\$cand"
fi
if command -v systemctl >/dev/null 2>&1 && systemctl is-active caddy >/dev/null 2>&1; then
  running=1
  execstart=\$(systemctl show caddy -p ExecStart --value 2>/dev/null || true)
  config=\$(echo "\$execstart" | sed -n 's/.*--config[= ]\\([^ ]*\\).*/\\1/p' | head -n 1)
  [ -n "\$config" ] || config=/etc/caddy/Caddyfile
  vcmd=""
  if command -v caddy >/dev/null 2>&1; then vcmd="caddy validate --config \$config --adapter caddyfile"; fi
  consider 40 systemd "" "\$config" "\$config" "\$vcmd" "systemctl reload caddy"
fi
if command -v pgrep >/dev/null 2>&1 && pgrep -x caddy >/dev/null 2>&1; then
  running=1
fi
if [ -z "\$best_host" ]; then
for f in /etc/caddy/Caddyfile "\$CT/Caddyfile" "\$CT/caddy/Caddyfile" "\$CT/deploy/Caddyfile" "\$CT/docker/Caddyfile"; do
  [ -n "\$f" ] && [ -f "\$f" ] || continue
  vcmd=""
  if command -v caddy >/dev/null 2>&1; then vcmd="caddy validate --config \$f --adapter caddyfile"; fi
  rcmd="\$vcmd"
  if [ -n "\$vcmd" ]; then rcmd=\${vcmd/validate/reload}; fi
  consider 10 file "" "\$f" "\$f" "\$vcmd" "\$rcmd"
done
fi
if [ "\$running" -ne 1 ] || [ -z "\$best_host" ]; then
  echo CADDY_NONE
  exit 0
fi
echo CADDY_OK
echo "via=\$best_via"
echo "container=\$best_container"
echo "hostPath=\$best_host"
echo "containerPath=\$best_container_path"
echo "validate=\$best_validate"
echo "reload=\$best_reload"
echo CADDY_B64_BEGIN
base64 "\$best_host" | awk '{printf "%s", \$0}'
echo
echo CADDY_B64_END
`.trim();
}

function applyScript(probe) {
  const b64 = String((probe && probe.b64) || "");
  const hostPath = String((probe && probe.hostPath) || "");
  const via = String((probe && probe.via) || "");
  const validateCmd = String((probe && probe.validateCmd) || "");
  const reloadCmd = String((probe && probe.reloadCmd) || "");
  return `
set -u
HOST_PATH=${JSON.stringify(hostPath)}
VIA=${JSON.stringify(via)}
VALIDATE=${JSON.stringify(validateCmd)}
RELOAD=${JSON.stringify(reloadCmd)}
case "\$HOST_PATH" in
  *Caddyfile*|*caddy*|*Caddy*) ;;
  *) echo "Refusing to edit \$HOST_PATH" >&2; exit 1 ;;
esac
[ -f "\$HOST_PATH" ] || { echo "Caddyfile not found: \$HOST_PATH" >&2; exit 1; }
NEW=\$(mktemp)
BAK="\${HOST_PATH}.bak-marketplace"
cleanup() { rm -f "\$NEW"; }
trap cleanup EXIT
printf '%s' ${JSON.stringify(b64)} | base64 -d > "\$NEW" || { echo "Could not decode the updated Caddyfile" >&2; exit 1; }
copy_over() {
  local src="\$1" dest="\$2"
  if cp "\$src" "\$dest" 2>/dev/null; then return 0; fi
  if sudo -n cp "\$src" "\$dest" 2>/dev/null; then return 0; fi
  return 1
}
run_cmd() {
  local cmd="\$1"
  [ -n "\$cmd" ] || return 0
  if bash -lc "\$cmd"; then return 0; fi
  if sudo -n bash -lc "\$cmd"; then return 0; fi
  return 1
}
cp -a "\$HOST_PATH" "\$BAK" 2>/dev/null || sudo -n cp -a "\$HOST_PATH" "\$BAK" || { echo "Could not back up \$HOST_PATH" >&2; exit 1; }
if [ "\$VIA" != "docker" ] && [ -n "\$VALIDATE" ]; then
  CHECK=\${VALIDATE}
  case "\$CHECK" in
    *"\$HOST_PATH"*) CHECK=\${CHECK//"\$HOST_PATH"/"\$NEW"} ;;
    *) CHECK="\$CHECK \$NEW" ;;
  esac
  if ! run_cmd "\$CHECK"; then
    echo "Caddy rejected the updated file. The original was left in place." >&2
    exit 1
  fi
fi
copy_over "\$NEW" "\$HOST_PATH" || { echo "Could not write \$HOST_PATH" >&2; exit 1; }
if [ "\$VIA" = "docker" ] && [ -n "\$VALIDATE" ]; then
  if ! run_cmd "\$VALIDATE"; then
    copy_over "\$BAK" "\$HOST_PATH" || true
    echo "Caddy rejected the updated file. The original was restored." >&2
    exit 1
  fi
fi
if [ -n "\$RELOAD" ]; then
  if ! run_cmd "\$RELOAD"; then
    copy_over "\$BAK" "\$HOST_PATH" || true
    run_cmd "\$RELOAD" || true
    echo "Caddy reload failed. The original file was restored." >&2
    exit 1
  fi
fi
echo APPLY_OK
echo "Backed up to \$BAK"
`.trim();
}

module.exports = {
  actionKey,
  isOptionalAction,
  isCaddyAction,
  applyCaddySnippets,
  snippetIsApplied,
  appliedKeys,
  extraConfigStatus,
  parseProbe,
  discoverScript,
  applyScript,
};
