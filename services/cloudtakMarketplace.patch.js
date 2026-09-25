"use strict";

const fs = require("fs");
const path = require("path");

const MAX_ANCHOR_GAP = 20;

function parsePatch(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const files = [];
  let file = null;
  let hunk = null;
  const flushHunk = () => {
    if (file && hunk) file.hunks.push(hunk);
    hunk = null;
  };
  for (const line of lines) {
    if (line.startsWith("diff ") || line.startsWith("--- ")) {
      flushHunk();
      continue;
    }
    if (line.startsWith("+++ ")) {
      flushHunk();
      const raw = line.slice(4).split("\t")[0].trim();
      file = { target: patchTarget(raw), hunks: [] };
      if (file.target) files.push(file);
      else file = null;
      continue;
    }
    if (line.startsWith("@@")) {
      flushHunk();
      if (!file) continue;
      hunk = { ops: [] };
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("\\")) continue;
    const kind = line[0];
    if (kind !== " " && kind !== "+" && kind !== "-") continue;
    hunk.ops.push({ kind, text: line.slice(1) });
  }
  flushHunk();
  return files;
}

function patchTarget(raw) {
  let rel = String(raw || "").trim();
  if (rel === "/dev/null") return "";
  if (rel.startsWith("b/") || rel.startsWith("a/")) rel = rel.slice(2);
  if (!rel || rel.startsWith("/") || rel.split("/").includes("..")) return "";
  return rel;
}

function isAnchor(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/^[{}()[\];,]+$/.test(t)) return false;
  return true;
}

function codeAdds(ops) {
  return ops.filter((op) => {
    if (op.kind !== "+") return false;
    const t = op.text.trim();
    if (!t) return false;
    if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) return false;
    return true;
  });
}

function findSubsequence(lines, anchors) {
  const need = [];
  for (const anchor of anchors) {
    if (!isAnchor(anchor.text)) continue;
    const idxs = [];
    const want = anchor.text.trim();
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === want) idxs.push(i);
    }
    if (!idxs.length) continue;
    need.push({ opIndex: anchor.opIndex, text: want, idxs });
  }
  if (!need.length) return null;
  if (need.length === 1) {
    if (need[0].idxs.length !== 1) return null;
    return [{ opIndex: need[0].opIndex, line: need[0].idxs[0] }];
  }
  let best = null;
  let ties = 0;
  const walk = (n, prev, acc) => {
    if (n === need.length) {
      const span = acc[acc.length - 1].line - acc[0].line;
      if (!best || span < best.span) {
        best = { span, acc: acc.map((row) => ({ ...row })) };
        ties = 1;
      } else if (span === best.span) {
        ties += 1;
      }
      return;
    }
    for (const idx of need[n].idxs) {
      if (prev != null && (idx <= prev || idx - prev > MAX_ANCHOR_GAP)) continue;
      acc.push({ opIndex: need[n].opIndex, line: idx });
      walk(n + 1, idx, acc);
      acc.pop();
    }
  };
  walk(0, null, []);
  if (!best || ties !== 1) return null;
  return best.acc;
}

function blockAlreadyNear(lines, dest, block) {
  const blockCode = codeAdds(block.map((text) => ({ kind: "+", text })));
  if (!blockCode.length) return false;
  const start = Math.max(0, dest - block.length - 8);
  const end = Math.min(lines.length, dest + 8);
  const window = lines.slice(start, end);
  let at = 0;
  for (const line of window) {
    if (line.trim() === blockCode[at].text.trim()) at += 1;
    if (at === blockCode.length) return true;
  }
  return false;
}

function applyHunk(lines, hunk) {
  const anchors = [];
  hunk.ops.forEach((op, opIndex) => {
    if (op.kind === " " || op.kind === "-") anchors.push({ opIndex, text: op.text });
  });
  const matched = findSubsequence(lines, anchors);
  if (!matched) return { ok: false, reason: "context no longer matches" };
  const at = new Map(matched.map((row) => [row.opIndex, row.line]));
  const inserts = new Map();
  const deletes = new Set();
  for (const row of matched) {
    if (hunk.ops[row.opIndex].kind === "-") deletes.add(row.line);
  }
  let cursor = 0;
  while (cursor < hunk.ops.length) {
    if (hunk.ops[cursor].kind !== "+") {
      cursor += 1;
      continue;
    }
    const start = cursor;
    const block = [];
    while (cursor < hunk.ops.length && hunk.ops[cursor].kind === "+") {
      block.push(hunk.ops[cursor].text);
      cursor += 1;
    }
    let dest = null;
    for (let i = cursor; i < hunk.ops.length; i++) {
      if (at.has(i)) {
        dest = at.get(i);
        break;
      }
    }
    if (dest == null) {
      for (let i = start - 1; i >= 0; i--) {
        if (at.has(i)) {
          dest = at.get(i) + 1;
          break;
        }
      }
    }
    if (dest == null) return { ok: false, reason: "could not place an added block" };
    if (blockAlreadyNear(lines, dest, block)) continue;
    const list = inserts.get(dest) || [];
    list.push(...block);
    inserts.set(dest, list);
  }
  const out = [];
  for (let i = 0; i <= lines.length; i++) {
    if (inserts.has(i)) out.push(...inserts.get(i));
    if (i < lines.length && !deletes.has(i)) out.push(lines[i]);
  }
  const changed = inserts.size > 0 || deletes.size > 0;
  return { ok: true, lines: out, already: !changed };
}

function applyPatchToText(source, patchText) {
  const hadNl = String(source).endsWith("\n");
  let lines = String(source).replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const files = parsePatch(patchText);
  const file = files[0];
  if (!file) return { ok: false, text: source, applied: 0, skipped: ["no hunks"] };
  let applied = 0;
  const skipped = [];
  file.hunks.forEach((hunk, index) => {
    const result = applyHunk(lines, hunk);
    if (!result.ok) {
      skipped.push(`hunk ${index + 1}: ${result.reason}`);
      return;
    }
    lines = result.lines;
    if (!result.already) applied += 1;
  });
  let text = lines.join("\n");
  if (hadNl) text += "\n";
  return { ok: skipped.length === 0, text, applied, skipped };
}

function listPatches(dir, out = []) {
  if (!dir || !fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".git") continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) listPatches(full, out);
    else if (ent.name.endsWith(".patch")) out.push(full);
  }
  return out;
}

function wireCotsReplayFlag(ctRoot) {
  const pool = path.join(ctRoot, "api/stateful/lib/connection-pool.ts");
  if (!fs.existsSync(pool)) return [];
  const poolText = fs.readFileSync(pool, "utf8");
  if (!/opts\s*:\s*\{\s*replay\?: boolean\s*\}/.test(poolText) && !/opts\.replay/.test(poolText)) return [];
  const notes = [];
  const typeFile = path.join(ctRoot, "api/common/hub/index.ts");
  if (fs.existsSync(typeFile)) {
    const text = fs.readFileSync(typeFile, "utf8");
    const match = text.match(/export type SubmitCotsRequest = \{[\s\S]*?\n\};/);
    if (match && !/replay\?: boolean/.test(match[0])) {
      const block = match[0].replace(/\n\};$/, "\n    replay?: boolean;\n};");
      fs.writeFileSync(typeFile, text.replace(match[0], block));
      notes.push("api/common/hub/index.ts");
    }
  }
  const localFile = path.join(ctRoot, "api/stateful/lib/hub/local.ts");
  if (fs.existsSync(localFile)) {
    const text = fs.readFileSync(localFile, "utf8");
    const from = ".cots(client.config, req.cots)";
    const to = ".cots(client.config, req.cots, { replay: req.replay === true })";
    if (text.includes(from) && !text.includes("{ replay: req.replay === true }")) {
      fs.writeFileSync(localFile, text.replace(from, to));
      notes.push("api/stateful/lib/hub/local.ts");
    }
  }
  return notes;
}

function applyRepoPatches(repoDir, ctRoot) {
  const patches = listPatches(repoDir);
  const skipped = [];
  let applied = 0;
  for (const patchPath of patches) {
    const parsed = parsePatch(fs.readFileSync(patchPath, "utf8"));
    for (const file of parsed) {
      if (!file.target) continue;
      const target = path.join(ctRoot, file.target);
      if (!fs.existsSync(target)) {
        skipped.push(`${file.target}: target file is missing`);
        continue;
      }
      const source = fs.readFileSync(target, "utf8");
      const result = applyPatchToText(source, fs.readFileSync(patchPath, "utf8"));
      if (result.applied) {
        fs.writeFileSync(target, result.text);
        applied += result.applied;
        console.log(`Applied ${result.applied} drifted hunk(s) in ${file.target}`);
      }
      for (const reason of result.skipped) skipped.push(`${file.target} ${reason}`);
    }
  }
  const wired = wireCotsReplayFlag(ctRoot);
  for (const note of wired) console.log(`Forwarded replay flag through ${note}`);
  if (skipped.length) {
    for (const reason of skipped) console.error(`ERROR: patch did not apply cleanly: ${reason}`);
    return { ok: false, applied, skipped, wired };
  }
  return { ok: true, applied, skipped, wired };
}

if (require.main === module) {
  const repo = process.argv[2];
  const ct = process.argv[3];
  if (!repo || !ct) {
    console.error("usage: node cloudtakMarketplace.patch.js <plugin-repo> <cloudtak-checkout>");
    process.exit(2);
  }
  const result = applyRepoPatches(repo, ct);
  process.exit(result.ok ? 0 : 1);
}

module.exports = {
  parsePatch,
  applyPatchToText,
  applyRepoPatches,
  wireCotsReplayFlag,
};
