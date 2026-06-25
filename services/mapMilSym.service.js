/**
 * Server-side 2525D military symbol generation (CloudTAK-style fallback).
 */
const { getInt } = require("./env");

const MILSYM_SIZE = getInt("MAP_MILSYM_SIZE", 48);

/** @type {Promise<typeof import('./mapMilSym.render.mjs')>|null} */
let esmPromise = null;

function loadEsm() {
  if (!esmPromise) {
    esmPromise = import("./mapMilSym.render.mjs");
  }
  return esmPromise;
}

function isCotTypeConvertable() {
  return false;
}

async function isCotTypeConvertableAsync(cotType) {
  const mod = await loadEsm();
  return mod.isCotTypeConvertable(cotType);
}

async function cotTypeTo2525DIconId(cotType) {
  const mod = await loadEsm();
  return mod.cotTypeTo2525DIconId(cotType);
}

async function cotTypeTo2525B(cotType) {
  const mod = await loadEsm();
  return mod.cotTypeTo2525B(cotType);
}

async function renderMilSymPng(cotType, size) {
  const mod = await loadEsm();
  return mod.renderMilSymPng(cotType, size != null ? size : MILSYM_SIZE);
}

async function renderMilSymPngByIconId(apiIconId, size) {
  const mod = await loadEsm();
  return mod.renderMilSymPngByIconId(apiIconId, size != null ? size : MILSYM_SIZE);
}

function isMilSymIconId(apiIconId) {
  return String(apiIconId || "").trim().startsWith("2525D:");
}

module.exports = {
  MILSYM_SIZE,
  isCotTypeConvertable,
  isCotTypeConvertableAsync,
  cotTypeTo2525DIconId,
  cotTypeTo2525B,
  renderMilSymPng,
  renderMilSymPngByIconId,
  isMilSymIconId,
};
