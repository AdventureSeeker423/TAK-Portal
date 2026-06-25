/**
 * ESM helper: CoT → 2525D SIDC → milsymbol PNG (used from mapMilSym.service.js).
 */
import ms from "milsymbol";
import Type2525 from "@tak-ps/node-cot/2525";
import sharp from "sharp";

const DEFAULT_SIZE = 48;

export function isCotTypeConvertable(cotType) {
  try {
    return Type2525.is2525BConvertable(String(cotType || "").trim());
  } catch {
    return false;
  }
}

export function cotTypeTo2525DIconId(cotType) {
  const t = String(cotType || "").trim();
  if (!isCotTypeConvertable(t)) return null;
  try {
    const sidc = Type2525.to2525D(t);
    return sidc ? `2525D:${sidc}` : null;
  } catch {
    return null;
  }
}

export function cotTypeTo2525B(cotType) {
  const t = String(cotType || "").trim();
  if (!isCotTypeConvertable(t)) return null;
  try {
    return Type2525.to2525B(t);
  } catch {
    return null;
  }
}

export async function renderMilSymPng(cotType, size = DEFAULT_SIZE) {
  const t = String(cotType || "").trim();
  if (!isCotTypeConvertable(t)) {
    throw new Error("CoT type is not 2525B-convertable");
  }
  const sidc = Type2525.to2525D(t);
  const symbol = new ms.Symbol(sidc, { size: Number(size) || DEFAULT_SIZE });
  const svg = symbol.asSVG();
  return sharp(Buffer.from(svg, "utf8")).png().toBuffer();
}

export async function renderMilSymPngByIconId(apiIconId, size = DEFAULT_SIZE) {
  const raw = String(apiIconId || "").trim();
  if (!raw.startsWith("2525D:")) {
    throw new Error("Expected 2525D: icon id");
  }
  const sidc = raw.slice("2525D:".length);
  const symbol = new ms.Symbol(sidc, { size: Number(size) || DEFAULT_SIZE });
  const svg = symbol.asSVG();
  return sharp(Buffer.from(svg, "utf8")).png().toBuffer();
}
