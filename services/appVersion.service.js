/**
 * Installed app version vs GitHub latest *stable* release.
 * Never flags a newer beta. The pill is only for being behind that stable tag.
 */
"use strict";

function stripVersionPrefix(v) {
  return String(v || "")
    .trim()
    .replace(/^v/i, "");
}

function isStableSemver(v) {
  return /^\d+\.\d+\.\d+$/.test(stripVersionPrefix(v));
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

function isUpdateAvailable(latestStable, pkg) {
  if (!isStableSemver(latestStable)) return false;
  const tag = stripVersionPrefix(latestStable);
  return isNewerVersion(tag, runningVersion(pkg));
}

module.exports = {
  stripVersionPrefix,
  isStableSemver,
  isNewerVersion,
  runningVersion,
  isUpdateAvailable,
};
