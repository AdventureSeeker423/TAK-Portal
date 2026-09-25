"use strict";

const fs = require("fs");
const path = require("path");

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".vue"]);
const RESOLVE_EXT = [".ts", ".tsx", ".js", ".mjs", ".vue", ".d.ts"];
const KEYWORDS = new Set([
  "await",
  "async",
  "return",
  "const",
  "let",
  "var",
  "function",
  "if",
  "else",
  "new",
  "typeof",
  "true",
  "false",
  "null",
  "undefined",
  "void",
  "this",
  "import",
  "export",
  "from",
  "as",
  "of",
  "in",
  "instanceof",
  "break",
  "continue",
  "throw",
  "try",
  "catch",
  "finally",
  "class",
  "extends",
  "static",
  "default",
  "case",
  "switch",
  "for",
  "while",
  "do",
  "yield",
  "delete",
  "type",
]);

function toPosix(p) {
  return String(p || "").split(path.sep).join("/");
}

function walkFiles(dir, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const ent of entries) {
    if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "dist") continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, out);
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

function readBalanced(source, openIndex, openCh, closeCh) {
  let i = openIndex;
  let depth = 0;
  let state = "code";
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (state === "code") {
      if (c === "/" && n === "/") {
        state = "line";
        i += 2;
        continue;
      }
      if (c === "/" && n === "*") {
        state = "block";
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === "`") {
        state = c;
        i += 1;
        continue;
      }
      if (c === openCh) depth += 1;
      else if (c === closeCh) {
        depth -= 1;
        if (depth === 0) return { start: openIndex, end: i };
      }
      i += 1;
      continue;
    }
    if (state === "line") {
      if (c === "\n") state = "code";
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") {
        state = "code";
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (c === "\\" && (state === "'" || state === '"' || state === "`")) {
      i += 2;
      continue;
    }
    if (c === state) state = "code";
    i += 1;
  }
  return null;
}

function keysFromTypeBody(body) {
  const keys = [];
  const re = /(?:^|[,;{\n])\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:/g;
  let m;
  while ((m = re.exec(body))) keys.push(m[1]);
  return keys;
}

function readSubscriptionLoadKeys(source) {
  const text = String(source || "");
  const start = text.search(/static\s+async\s+load\s*\(/);
  if (start < 0) return null;
  const head = text.slice(start, start + 1200);
  const inline = head.match(/\bopts\??\s*:\s*\{/);
  if (inline) {
    const brace = start + head.indexOf(inline[0]) + inline[0].length - 1;
    const span = readBalanced(text, brace, "{", "}");
    if (!span) return null;
    return keysFromTypeBody(text.slice(span.start, span.end + 1));
  }
  const named = head.match(/\bopts\??\s*:\s*([A-Za-z_$][\w$]*)/);
  if (!named) return null;
  const typeName = named[1];
  const aliasRe = new RegExp("(?:type|interface)\\s+" + typeName + "\\b[^\\{]*\\{");
  const alias = aliasRe.exec(text);
  if (!alias) return null;
  const brace = text.indexOf("{", alias.index);
  const span = readBalanced(text, brace, "{", "}");
  if (!span) return null;
  return keysFromTypeBody(text.slice(span.start, span.end + 1));
}

function hostHasMethod(source, name) {
  const re = new RegExp(
    "(?:^|\\n)[ \\t]*(?:(?:public|private|protected|async|static|readonly|override)\\s+)*" +
      name +
      "\\s*\\(",
    "m"
  );
  return re.test(String(source || ""));
}

function indexHostSources(webSrc) {
  const byBase = new Map();
  if (!webSrc || !fs.existsSync(webSrc)) return byBase;
  for (const full of walkFiles(webSrc, [])) {
    const base = path.basename(full);
    const list = byBase.get(base) || [];
    list.push(full);
    byBase.set(base, list);
  }
  return byBase;
}

function resolveExisting(absNoQuery) {
  if (fs.existsSync(absNoQuery)) {
    try {
      if (fs.statSync(absNoQuery).isFile()) return absNoQuery;
      for (const ext of RESOLVE_EXT) {
        const indexFile = path.join(absNoQuery, "index" + ext);
        if (fs.existsSync(indexFile)) return indexFile;
      }
    } catch (_) {}
  }
  const ext = path.extname(absNoQuery);
  if (!ext) {
    for (const add of RESOLVE_EXT) {
      const candidate = absNoQuery + add;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return null;
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function repairImports(filePath, source, ctx) {
  const changes = [];
  if (!ctx.hostIndex) return { code: source, changes };
  const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)(['"])(\.[^'"]+)\1/g;
  let code = source;
  const matches = [];
  let m;
  while ((m = re.exec(source))) {
    matches.push({ index: m.index, spec: m[2], quote: m[1], specAt: m.index + m[0].length - m[2].length - 1 });
  }
  for (let i = matches.length - 1; i >= 0; i--) {
    const item = matches[i];
    if (item.spec.includes("?") || item.spec.includes("*")) continue;
    const resolved = path.resolve(path.dirname(filePath), item.spec);
    if (isInside(ctx.pluginDir, resolved)) continue;
    if (resolveExisting(resolved)) continue;
    const base = path.basename(item.spec);
    const hits = ctx.hostIndex.get(base) || [];
    if (hits.length !== 1) continue;
    let next = toPosix(path.relative(path.dirname(filePath), hits[0]));
    if (!next.startsWith(".")) next = "./" + next;
    if (next === item.spec) continue;
    const at = item.specAt;
    code = code.slice(0, at) + next + code.slice(at + item.spec.length);
    const relFile = toPosix(path.relative(ctx.pluginDir, filePath));
    changes.push(relFile + ": import " + item.spec + " -> " + next);
  }
  return { code, changes: changes.reverse() };
}

function parseObjectProperties(obj) {
  const props = [];
  let i = 1;
  let state = "code";
  let brace = 1;
  let paren = 0;
  let bracket = 0;
  let phase = "seek";
  let propStart = -1;
  let key = "";
  let keyStart = -1;
  let keyEnd = -1;

  function push(end) {
    if (!key || propStart < 0) {
      key = "";
      phase = "seek";
      propStart = -1;
      return;
    }
    props.push({ key, keyStart, keyEnd, start: propStart, end });
    key = "";
    phase = "seek";
    propStart = -1;
  }

  while (i < obj.length) {
    const c = obj[i];
    const n = obj[i + 1];
    if (state === "line") {
      if (c === "\n") state = "code";
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") {
        state = "code";
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === "'" || state === '"' || state === "`") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === state) state = "code";
      i += 1;
      continue;
    }
    if (c === "/" && n === "/") {
      state = "line";
      i += 2;
      continue;
    }
    if (c === "/" && n === "*") {
      state = "block";
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      state = c;
      i += 1;
      continue;
    }

    if (c === "{") brace += 1;
    else if (c === "}") {
      brace -= 1;
      if (brace === 0) {
        if (phase === "value") push(i);
        break;
      }
    } else if (c === "(") paren += 1;
    else if (c === ")") paren -= 1;
    else if (c === "[") bracket += 1;
    else if (c === "]") bracket -= 1;

    const top = brace === 1 && paren === 0 && bracket === 0;
    if (top && phase === "seek") {
      if (c === "'" || c === '"') {
        propStart = i;
        const q = c;
        const start = i + 1;
        i += 1;
        while (i < obj.length && obj[i] !== q) {
          if (obj[i] === "\\") i += 2;
          else i += 1;
        }
        key = obj.slice(start, i);
        keyStart = propStart;
        keyEnd = Math.min(obj.length, i + 1);
        phase = "afterKey";
      } else if (/[A-Za-z_$]/.test(c)) {
        propStart = i;
        keyStart = i;
        let j = i + 1;
        while (j < obj.length && /[\w$]/.test(obj[j])) j += 1;
        keyEnd = j;
        key = obj.slice(keyStart, keyEnd);
        phase = "afterKey";
        i = j - 1;
      } else if (c === "." && n === "." && obj[i + 2] === ".") {
        phase = "spread";
        propStart = i;
        key = "";
      }
    } else if (top && phase === "afterKey") {
      if (c === ":") phase = "value";
      else if (c === ",") push(i + 1);
    } else if (top && (phase === "value" || phase === "spread") && c === ",") {
      push(i + 1);
    }
    i += 1;
  }
  return props;
}

function rewriteLoadObject(obj, hostKeys) {
  if (!Array.isArray(hostKeys) || hostKeys.includes("token")) {
    return { text: obj, removed: [] };
  }
  const props = parseObjectProperties(obj);
  const tokenProp = props.find((p) => p.key === "token");
  if (!tokenProp) return { text: obj, removed: [] };
  const hasMission = props.some((p) => p.key === "missiontoken");
  if (hostKeys.includes("missiontoken") && !hasMission) {
    return {
      text: obj.slice(0, tokenProp.keyStart) + "missiontoken" + obj.slice(tokenProp.keyEnd),
      removed: [],
      renamed: true,
    };
  }
  const removed = [obj.slice(tokenProp.start, tokenProp.end)];
  let cutStart = tokenProp.start;
  let cutEnd = tokenProp.end;
  const lineBreak = obj.lastIndexOf("\n", cutStart - 1);
  if (lineBreak >= 0 && obj.slice(lineBreak + 1, cutStart).trim() === "") cutStart = lineBreak + 1;
  if (cutEnd < obj.length && obj[cutEnd] !== "}") {
    while (cutEnd < obj.length && /[ \t]/.test(obj[cutEnd])) cutEnd += 1;
    if (obj[cutEnd] === "\r") cutEnd += 1;
    if (obj[cutEnd] === "\n") cutEnd += 1;
  }
  if (cutStart > 1 && obj[cutEnd] === "}" && obj[cutStart - 1] === ",") cutStart -= 1;
  return {
    text: obj.slice(0, cutStart) + obj.slice(cutEnd),
    removed,
    renamed: false,
  };
}

function findLoadCalls(source, localName) {
  const calls = [];
  const needle = localName + ".load";
  let from = 0;
  while (from < source.length) {
    const at = source.indexOf(needle, from);
    if (at < 0) break;
    const before = at > 0 ? source[at - 1] : "";
    if (before && /[\w$]/.test(before)) {
      from = at + needle.length;
      continue;
    }
    let i = at + needle.length;
    while (i < source.length && /\s/.test(source[i])) i += 1;
    if (source[i] !== "(") {
      from = at + needle.length;
      continue;
    }
    const span = readBalanced(source, i, "(", ")");
    if (!span) break;
    calls.push({ start: at, paren: span });
    from = span.end + 1;
  }
  return calls;
}

function splitTopLevelArgs(inner) {
  const args = [];
  let state = "code";
  let brace = 0;
  let paren = 0;
  let bracket = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    const n = inner[i + 1];
    if (state === "line") {
      if (c === "\n") state = "code";
      continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") {
        state = "code";
        i += 1;
      }
      continue;
    }
    if (state === "'" || state === '"' || state === "`") {
      if (c === "\\") {
        i += 1;
        continue;
      }
      if (c === state) state = "code";
      continue;
    }
    if (c === "/" && n === "/") {
      state = "line";
      i += 1;
      continue;
    }
    if (c === "/" && n === "*") {
      state = "block";
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      state = c;
      continue;
    }
    if (c === "{") brace += 1;
    else if (c === "}") brace -= 1;
    else if (c === "(") paren += 1;
    else if (c === ")") paren -= 1;
    else if (c === "[") bracket += 1;
    else if (c === "]") bracket -= 1;
    else if (c === "," && brace === 0 && paren === 0 && bracket === 0) {
      args.push({ start, end: i });
      start = i + 1;
    }
  }
  args.push({ start, end: inner.length });
  return args;
}

function subscriptionLocalName(source) {
  const re = /import\s+([A-Za-z_$][\w$]*)\s+from\s+['"][^'"]*\/subscription(?:\.ts)?['"]/;
  const m = re.exec(source);
  return m ? m[1] : null;
}

function rewriteSubscriptionLoad(filePath, source, ctx) {
  const changes = [];
  const removedChunks = [];
  if (!Array.isArray(ctx.loadKeys)) return { code: source, changes, removedChunks };
  const localName = subscriptionLocalName(source);
  if (!localName) return { code: source, changes, removedChunks };
  const calls = findLoadCalls(source, localName);
  let code = source;
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    const inner = code.slice(call.paren.start + 1, call.paren.end);
    const args = splitTopLevelArgs(inner);
    if (args.length < 2) continue;
    const arg = args[1];
    const raw = inner.slice(arg.start, arg.end);
    const lead = raw.match(/^\s*/)[0];
    const trail = raw.match(/\s*$/)[0];
    const body = raw.slice(lead.length, raw.length - trail.length);
    if (!body.startsWith("{")) continue;
    const span = readBalanced(body, 0, "{", "}");
    if (!span || span.end !== body.length - 1) continue;
    const edited = rewriteLoadObject(body, ctx.loadKeys);
    if (edited.text === body) continue;
    const relFile = toPosix(path.relative(ctx.pluginDir, filePath));
    if (edited.renamed) {
      changes.push(relFile + ": Subscription.load option token -> missiontoken");
    } else {
      changes.push(relFile + ": dropped Subscription.load session token (host no longer accepts it)");
      removedChunks.push(...edited.removed);
    }
    const nextInner = inner.slice(0, arg.start) + lead + edited.text + trail + inner.slice(arg.end);
    code = code.slice(0, call.paren.start + 1) + nextInner + code.slice(call.paren.end);
  }
  return { code, changes: changes.reverse(), removedChunks };
}

function rewriteConnReconnect(filePath, source, ctx) {
  if (!ctx.rewriteReconnect) return { code: source, changes: [] };
  const re = /(\bconn\??)\.reconnect\s*\(/g;
  if (!re.test(source)) return { code: source, changes: [] };
  const code = source.replace(/(\bconn\??)\.reconnect\s*\(/g, "$1.connect(");
  const relFile = toPosix(path.relative(ctx.pluginDir, filePath));
  return {
    code,
    changes: [relFile + ": conn.reconnect -> conn.connect"],
  };
}

function countIdent(source, name) {
  const re = new RegExp("\\b" + name + "\\b", "g");
  const m = source.match(re);
  return m ? m.length : 0;
}

function identifiersIn(text) {
  const ids = [];
  const re = /\b([A-Za-z_$][\w$]*)\b/g;
  let m;
  while ((m = re.exec(text))) {
    if (!KEYWORDS.has(m[1]) && !ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

function removeFunctionDeclaration(source, name) {
  const re = new RegExp("(?:^|\\n)[ \\t]*(?:async\\s+)?function\\s+" + name + "\\s*\\(");
  const m = re.exec(source);
  if (!m) return null;
  const lineStart = source.lastIndexOf("\n", m.index) + 1;
  const prefix = source.slice(lineStart, m.index + m[0].length);
  if (/\bexport\b/.test(prefix)) return null;
  const parenAt = source.indexOf("(", m.index);
  const params = readBalanced(source, parenAt, "(", ")");
  if (!params) return null;
  let i = params.end + 1;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  if (source[i] === ":") {
    i += 1;
    let angle = 0;
    let paren = 0;
    let bracket = 0;
    while (i < source.length) {
      const c = source[i];
      if (c === "<") angle += 1;
      else if (c === ">") angle = Math.max(0, angle - 1);
      else if (c === "(") paren += 1;
      else if (c === ")") paren = Math.max(0, paren - 1);
      else if (c === "[") bracket += 1;
      else if (c === "]") bracket = Math.max(0, bracket - 1);
      else if (c === "{" && angle === 0 && paren === 0 && bracket === 0) {
        const typed = readBalanced(source, i, "{", "}");
        if (!typed) return null;
        let j = typed.end + 1;
        while (j < source.length && /\s/.test(source[j])) j += 1;
        if (source[j] === "{") {
          i = j;
          break;
        }
        break;
      }
      i += 1;
    }
  }
  if (source[i] !== "{") return null;
  const body = readBalanced(source, i, "{", "}");
  if (!body) return null;
  let end = body.end + 1;
  if (source[end] === "\r") end += 1;
  if (source[end] === "\n") end += 1;
  return {
    code: source.slice(0, lineStart) + source.slice(end),
    body: source.slice(body.start, body.end + 1),
  };
}

function specifierLocal(part) {
  const t = String(part || "").trim();
  if (!t) return "";
  const as = t.split(/\s+as\s+/);
  return (as.length > 1 ? as[as.length - 1] : as[0]).trim();
}

function splitSpecifiers(inner) {
  const parts = [];
  let state = "code";
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    const n = inner[i + 1];
    if (state === "'" || state === '"' || state === "`") {
      if (c === "\\") {
        i += 1;
        continue;
      }
      if (c === state) state = "code";
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      state = c;
      continue;
    }
    if (c === "{" || c === "(" || c === "[") depth += 1;
    else if (c === "}" || c === ")" || c === "]") depth -= 1;
    else if (c === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
    void n;
  }
  parts.push(inner.slice(start));
  return parts;
}

function importBindings(clause) {
  const text = String(clause || "").trim();
  const bindings = [];
  const brace = text.indexOf("{");
  if (brace >= 0) {
    const end = text.lastIndexOf("}");
    const inner = text.slice(brace + 1, end);
    for (const part of splitSpecifiers(inner)) {
      const local = specifierLocal(part);
      if (local) bindings.push(local);
    }
    const before = text.slice(0, brace).replace(/,$/, "").trim();
    if (before) bindings.unshift(before.split(/\s+/).pop());
    return bindings.filter(Boolean);
  }
  if (text) bindings.push(text.split(/\s+/)[0]);
  return bindings.filter(Boolean);
}

function stripUnusedImport(source, name) {
  if (countIdent(source, name) !== 1) return source;
  const re = /(^|\n)([ \t]*import\s+(?:type\s+)?)([\s\S]*?)\s+from\s+(['"][^'"]+['"])\s*;?[ \t]*(?:\r?\n|$)/g;
  let match;
  while ((match = re.exec(source))) {
    const clause = match[3];
    const bindings = importBindings(clause);
    if (!bindings.includes(name)) continue;
    const fullStart = match.index + (match[1] === "\n" ? 1 : 0);
    const fullEnd = match.index + match[0].length;
    if (bindings.length === 1) {
      return source.slice(0, fullStart) + source.slice(fullEnd);
    }
    const brace = clause.indexOf("{");
    const endBrace = clause.lastIndexOf("}");
    if (brace < 0 || endBrace < 0) return source;
    const kept = splitSpecifiers(clause.slice(brace + 1, endBrace)).filter((part) => specifierLocal(part) !== name);
    const before = clause.slice(0, brace).trim();
    const nextClause = (before ? before.replace(/,$/, "").trim() + " " : "") + "{ " + kept.map((p) => p.trim()).join(", ") + " }";
    const rebuilt =
      source.slice(0, fullStart) +
      match[2].replace(/^\s*/, (s) => s) +
      nextClause +
      " from " +
      match[4] +
      ";\n" +
      source.slice(fullEnd);
    return rebuilt;
  }
  return source;
}

function stripUnreferencedHelpers(source, seeds) {
  let code = source;
  let names = Array.isArray(seeds) ? seeds.filter((n) => n && !KEYWORDS.has(n)) : [];
  const seen = new Set();
  let guard = 0;
  while (names.length && guard < 30) {
    guard += 1;
    const next = [];
    for (const name of names) {
      if (seen.has(name)) continue;
      if (countIdent(code, name) !== 1) continue;
      const removed = removeFunctionDeclaration(code, name);
      if (!removed) continue;
      seen.add(name);
      code = removed.code;
      for (const id of identifiersIn(removed.body)) {
        if (!seen.has(id)) next.push(id);
      }
    }
    for (const name of next) {
      if (countIdent(code, name) === 1) code = stripUnusedImport(code, name);
    }
    names = next;
  }
  for (const name of seeds || []) {
    if (countIdent(code, name) === 1) code = stripUnusedImport(code, name);
  }
  return code;
}

function transformCode(filePath, source, ctx) {
  const changes = [];
  let code = source;
  const imports = repairImports(filePath, code, ctx);
  code = imports.code;
  changes.push(...imports.changes);
  const loads = rewriteSubscriptionLoad(filePath, code, ctx);
  code = loads.code;
  changes.push(...loads.changes);
  const conn = rewriteConnReconnect(filePath, code, ctx);
  code = conn.code;
  changes.push(...conn.changes);
  const seeds = [];
  for (const chunk of loads.removedChunks || []) seeds.push(...identifiersIn(chunk));
  if (seeds.length) code = stripUnreferencedHelpers(code, seeds);
  return { code, changes };
}

function transformFile(filePath, source, ctx) {
  if (!filePath.endsWith(".vue")) return transformCode(filePath, source, ctx);
  const changes = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let code = "";
  let last = 0;
  let m;
  while ((m = re.exec(source))) {
    const updated = transformCode(filePath, m[2], ctx);
    changes.push(...updated.changes);
    code += source.slice(last, m.index) + "<script" + m[1] + ">" + updated.code + "</script>";
    last = m.index + m[0].length;
  }
  code += source.slice(last);
  if (last === 0) return { code: source, changes: [] };
  return { code, changes };
}

function alignPluginDir(pluginDir, ctx) {
  const changes = [];
  const local = Object.assign({}, ctx, { pluginDir });
  for (const file of walkFiles(pluginDir, [])) {
    if (!SOURCE_EXT.has(path.extname(file).toLowerCase())) continue;
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (_) {
      continue;
    }
    const updated = transformFile(file, text, local);
    if (updated.code !== text) {
      fs.writeFileSync(file, updated.code);
      changes.push(...updated.changes);
    }
  }
  return changes;
}

function relaxHostPluginLint(webDir) {
  const pkgPath = path.join(webDir, "package.json");
  if (!fs.existsSync(pkgPath)) return [];
  let text = "";
  try {
    text = fs.readFileSync(pkgPath, "utf8");
  } catch (_) {
    return [];
  }
  const next = text.replace(/("lint"\s*:\s*")((?:\\.|[^"\\])*)(")/, (full, open, script, close) => {
    if (!script.includes("./plugins")) return full;
    const updated = script.replace(/(?:^|\s)\.\/plugins\/?(?=\s|$)/g, "").replace(/[ \t]{2,}/g, " ").trim();
    if (!updated || updated === script) return full;
    return open + updated + close;
  });
  if (next === text) return [];
  fs.writeFileSync(pkgPath, next);
  return ["api/web/package.json: image lint no longer includes marketplace plugin files"];
}

const MARKETPLACE_TSCONFIG = "tsconfig.marketplace.json";

function marketplaceTsconfigText() {
  return JSON.stringify({
    extends: "./tsconfig.json",
    exclude: ["plugins", "node_modules", "dist"],
  }, null, 2) + "\n";
}

function relaxHostPluginCheck(webDir) {
  const pkgPath = path.join(webDir, "package.json");
  if (!fs.existsSync(pkgPath)) return [];
  let text = "";
  try {
    text = fs.readFileSync(pkgPath, "utf8");
  } catch (_) {
    return [];
  }
  const changes = [];
  const next = text.replace(/("check"\s*:\s*")((?:\\.|[^"\\])*)(")/, (full, open, script, close) => {
    if (!/\bvue-tsc\b/.test(script) || script.includes(MARKETPLACE_TSCONFIG)) return full;
    const stripped = script.replace(/(?:--project|-p)\s+\S+/g, " ").replace(/[ \t]{2,}/g, " ").trim();
    const updated = stripped.replace(/\bvue-tsc\b/, "vue-tsc --project " + MARKETPLACE_TSCONFIG);
    if (!updated || updated === script) return full;
    return open + updated + close;
  });
  if (next !== text) {
    fs.writeFileSync(pkgPath, next);
    changes.push("api/web/package.json: image typecheck no longer includes marketplace plugin files");
  }
  if (!next.includes(MARKETPLACE_TSCONFIG)) return changes;
  const overlayPath = path.join(webDir, MARKETPLACE_TSCONFIG);
  const overlay = marketplaceTsconfigText();
  let existing = "";
  try {
    if (fs.existsSync(overlayPath)) existing = fs.readFileSync(overlayPath, "utf8");
  } catch (_) {
    return changes;
  }
  if (existing === overlay) return changes;
  fs.writeFileSync(overlayPath, overlay);
  changes.push("api/web/" + MARKETPLACE_TSCONFIG + ": typecheck excludes marketplace plugin files");
  return changes;
}

function indentOf(line) {
  const m = String(line || "").match(/^[ \t]*/);
  return m ? m[0].length : 0;
}

function composeServiceNames(text) {
  const lines = String(text || "").split(/\r?\n/);
  let inServices = false;
  let serviceIndent = null;
  const names = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!inServices) {
      if (/^services:\s*(?:#.*)?$/.test(trimmed)) inServices = true;
      continue;
    }
    if (/^\S/.test(line)) break;
    const m = line.match(/^[ \t]+([A-Za-z0-9._-]+):\s*(?:#.*)?$/);
    if (!m) continue;
    const indent = indentOf(line);
    if (serviceIndent == null) serviceIndent = indent;
    if (indent === serviceIndent) names.push(m[1]);
    else if (indent < serviceIndent) break;
  }
  return names;
}

function resolveDepName(name, known, project) {
  const raw = String(name || "").replace(/^['"]|['"]$/g, "");
  if (!raw) return "";
  if (known.has(raw)) return raw;
  const prefix = project ? String(project).replace(/\/+$/, "").split(/[\\/]/).pop().toLowerCase() + "-" : "";
  if (prefix && raw.toLowerCase().startsWith(prefix)) {
    const tail = raw.slice(prefix.length);
    for (const svc of known) {
      if (svc.toLowerCase() === tail.toLowerCase()) return svc;
    }
  }
  return "";
}

function filterDependsEntries(block, known, project, notes) {
  const kept = [];
  const seen = new Set();
  let i = 0;
  while (i < block.length) {
    const line = block[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      i += 1;
      continue;
    }
    const list = line.match(/^([ \t]*)-\s+([^:#\s]+)\s*(?:#.*)?$/);
    if (list) {
      const name = list[2].replace(/^['"]|['"]$/g, "");
      const resolved = resolveDepName(name, known, project);
      if (!resolved) notes.push("dropped " + name);
      else if (!seen.has(resolved)) {
        seen.add(resolved);
        if (resolved !== name) notes.push(name + " -> " + resolved);
        kept.push(list[1] + "- " + resolved);
      }
      i += 1;
      continue;
    }
    const map = line.match(/^([ \t]*)([A-Za-z0-9._-]+):\s*(.*)$/);
    if (map && !line.trim().startsWith("-")) {
      const keyIndent = map[1].length;
      const nested = [];
      let j = i + 1;
      while (j < block.length) {
        const nxt = block[j];
        if (!nxt.trim()) {
          nested.push(nxt);
          j += 1;
          continue;
        }
        if (indentOf(nxt) <= keyIndent) break;
        nested.push(nxt);
        j += 1;
      }
      const resolved = resolveDepName(map[2], known, project);
      if (!resolved) notes.push("dropped " + map[2]);
      else if (!seen.has(resolved)) {
        seen.add(resolved);
        if (resolved !== map[2]) notes.push(map[2] + " -> " + resolved);
        kept.push(map[1] + resolved + ":" + (map[3] ? " " + map[3].trim() : ""));
        while (nested.length && !nested[nested.length - 1].trim()) nested.pop();
        kept.push(...nested);
      }
      i = j;
      continue;
    }
    kept.push(line);
    i += 1;
  }
  return kept;
}

function rewriteComposeDepends(text, externalNames, project) {
  const raw = String(text == null ? "" : text);
  const trailingNl = raw.endsWith("\n");
  const lines = raw.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const known = new Set(composeServiceNames(raw).concat(externalNames || []).filter(Boolean));
  const out = [];
  const notes = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const dep = line.match(/^([ \t]*)depends_on:\s*(.*)$/);
    if (!dep || line.trim().startsWith("#")) {
      out.push(line);
      i += 1;
      continue;
    }
    const indent = dep[1].length;
    const rest = dep[2].trim();
    if (rest && rest !== "|" && rest !== ">" && !rest.startsWith("#")) {
      const names = rest
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
      const keep = [];
      names.forEach((name) => {
        const resolved = resolveDepName(name, known, project);
        if (!resolved) notes.push("dropped " + name);
        else {
          if (resolved !== name) notes.push(name + " -> " + resolved);
          if (!keep.includes(resolved)) keep.push(resolved);
        }
      });
      if (keep.length) out.push(dep[1] + "depends_on: [" + keep.join(", ") + "]");
      i += 1;
      continue;
    }
    const block = [];
    let j = i + 1;
    while (j < lines.length) {
      const nxt = lines[j];
      if (!nxt.trim()) {
        block.push(nxt);
        j += 1;
        continue;
      }
      if (indentOf(nxt) <= indent) break;
      block.push(nxt);
      j += 1;
    }
    const kept = filterDependsEntries(block, known, project, notes);
    if (kept.length) {
      out.push(dep[1] + "depends_on:");
      out.push(...kept);
    }
    i = j;
  }
  let joined = out.join("\n");
  if (trailingNl) joined += "\n";
  return { text: joined, notes };
}

function fixComposeDependsFile(overlayPath, basePaths, project) {
  const overlay = fs.readFileSync(overlayPath, "utf8");
  const known = [];
  for (const p of basePaths || []) {
    try {
      if (p && fs.existsSync(p)) known.push(...composeServiceNames(fs.readFileSync(p, "utf8")));
    } catch (_) {}
  }
  const result = rewriteComposeDepends(overlay, known, project);
  if (result.text === overlay) return result;
  fs.writeFileSync(overlayPath, result.text);
  return result;
}

function alignInstalledPlugins(ctRoot) {
  const root = String(ctRoot || "").trim();
  const web = path.join(root, "api", "web");
  const webSrc = path.join(web, "src");
  const plugins = path.join(web, "plugins");
  if (!root || !fs.existsSync(webSrc) || !fs.existsSync(plugins)) {
    return { ok: true, changes: [], skipped: true };
  }
  const subPath = path.join(webSrc, "base", "subscription.ts");
  const atlasPath = path.join(webSrc, "workers", "atlas-connection.ts");
  let subSrc = "";
  let atlasSrc = "";
  try {
    if (fs.existsSync(subPath)) subSrc = fs.readFileSync(subPath, "utf8");
  } catch (_) {}
  try {
    if (fs.existsSync(atlasPath)) atlasSrc = fs.readFileSync(atlasPath, "utf8");
  } catch (_) {}
  const ctx = {
    loadKeys: subSrc ? readSubscriptionLoadKeys(subSrc) : null,
    rewriteReconnect: Boolean(atlasSrc && hostHasMethod(atlasSrc, "connect") && !hostHasMethod(atlasSrc, "reconnect")),
    hostIndex: indexHostSources(webSrc),
  };
  const changes = [];
  let entries = [];
  try {
    entries = fs.readdirSync(plugins, { withFileTypes: true });
  } catch (err) {
    return { ok: false, changes, message: err.message || String(err) };
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    changes.push(...alignPluginDir(path.join(plugins, ent.name), ctx));
  }
  changes.push(...relaxHostPluginLint(web));
  changes.push(...relaxHostPluginCheck(web));
  return { ok: true, changes };
}

function main() {
  if (process.argv[2] === "--fix-compose-depends") {
    const args = process.argv.slice(3);
    const paths = [];
    let project = "";
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "--project") {
        project = args[i + 1] || "";
        i += 1;
        continue;
      }
      paths.push(args[i]);
    }
    const overlayPath = paths[0];
    if (!overlayPath) {
      console.error("overlay path required");
      process.exit(1);
    }
    const result = fixComposeDependsFile(overlayPath, paths.slice(1), project);
    if (result.text && result.notes && result.notes.length) {
      console.log("Adjusted plugin depends_on to services in this CloudTAK stack");
      result.notes.forEach((line) => console.log("  " + line));
    }
    return;
  }
  const ct = process.argv[2];
  if (!ct) {
    console.error("CloudTAK path required");
    process.exit(1);
  }
  const result = alignInstalledPlugins(ct);
  if (!result.ok) {
    console.error(result.message || "Could not align plugins");
    process.exit(1);
  }
  if (!result.changes.length) {
    console.log(result.skipped ? "No CloudTAK plugin tree to align" : "Plugin source already matches this CloudTAK API");
    return;
  }
  const n = result.changes.length;
  console.log("Aligned plugin source to this CloudTAK API (" + n + (n === 1 ? " change)" : " changes)"));
  for (const line of result.changes) console.log("  " + line);
}

if (require.main === module) main();

module.exports = {
  alignInstalledPlugins,
  readSubscriptionLoadKeys,
  hostHasMethod,
  parseObjectProperties,
  rewriteLoadObject,
  relaxHostPluginLint,
  relaxHostPluginCheck,
  composeServiceNames,
  rewriteComposeDepends,
  fixComposeDependsFile,
};
