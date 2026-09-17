/**
 * Installed app version vs GitHub latest.
 * `package.json` `version` is the last stable; `beta-version` is the running
 * post-stable build when present and newer.
 */
"use strict";

function stripVersionPrefix(v) {
  return String(v || "")
    .trim()
    .replace(/^v/i, "");
}

function isNewerVersion(latest, current) {
  const toParts = (v) =>
    String(v || "0.0.0")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const [la, lb, lc] = toParts(stripVersionPrefix(latest));
  const [ca, cb, cc] = toParts(stripVersionPrefix(current));
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

function runningVersion(pkg) {
  const stable = stripVersionPrefix(pkg?.version || "0.0.0");
  const beta = stripVersionPrefix(pkg?.["beta-version"] || "");
  if (beta && isNewerVersion(beta, stable)) return beta;
  return stable || "0.0.0";
}

function isUpdateAvailable(latest, pkg) {
  const tag = stripVersionPrefix(latest);
  if (!/^\d+\.\d+\.\d+/.test(tag)) return false;
  return isNewerVersion(tag, runningVersion(pkg));
}

module.exports = {
  stripVersionPrefix,
  isNewerVersion,
  runningVersion,
  isUpdateAvailable,
};
