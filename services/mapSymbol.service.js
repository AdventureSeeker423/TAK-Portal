/**
 * MIL-STD-2525 symbol resolution + server-side PNG rendering for the map.
 */
const ms = require("milsymbol");

let Type2525 = null;
let loadPromise = null;

async function ensureType2525() {
  if (Type2525) return Type2525;
  if (!loadPromise) {
    loadPromise = import("@tak-ps/node-cot/2525")
      .then((mod) => {
        Type2525 = mod.default;
        return Type2525;
      })
      .catch((err) => {
        loadPromise = null;
        throw err;
      });
  }
  return loadPromise;
}

void ensureType2525().catch((err) => {
  console.warn("[map-symbol] failed to load Type2525:", err?.message || err);
});

function symbolIconId(cotType) {
  return `sym:${String(cotType || "").trim()}`;
}

function parseSymbolIconId(iconId) {
  const raw = String(iconId || "").trim();
  if (!raw.startsWith("sym:")) return null;
  const type = raw.slice(4).trim();
  return type || null;
}

function resolveSymbolSidc2525B(cotType) {
  if (!Type2525) return null;
  const type = String(cotType || "").trim();
  if (!type || !Type2525.is2525BConvertable(type)) return null;
  try {
    return Type2525.to2525B(type);
  } catch {
    return null;
  }
}

function resolveSymbolSidc2525D(cotType) {
  if (!Type2525) return null;
  const type = String(cotType || "").trim();
  if (!type || !Type2525.is2525BConvertable(type)) return null;
  try {
    return Type2525.to2525D(type);
  } catch {
    return null;
  }
}

function isMilSymbolType(cotType) {
  if (!Type2525) return false;
  return Type2525.is2525BConvertable(String(cotType || "").trim());
}

function renderSymbolPng(cotType, options = {}) {
  const type = String(cotType || "").trim();
  if (!type) return null;

  const sidc2525B = resolveSymbolSidc2525B(type);
  if (!sidc2525B) return null;

  const course = Number(options.course);
  const sym = new ms.Symbol(sidc2525B, {
    size: Number(options.size) || 50,
    direction: Number.isFinite(course) && course >= 0 ? course : undefined,
    outlineColor: "#0b0f14",
    outlineWidth: 4,
  });

  try {
    const dataUrl = sym.toDataURL();
    const base64 = String(dataUrl || "").replace(/^data:image\/png;base64,/, "");
    if (!base64) return null;
    return Buffer.from(base64, "base64");
  } catch {
    return null;
  }
}

function enrichMarkerSymbol(marker) {
  if (!marker || typeof marker !== "object") return marker;
  marker.milSymbol = isMilSymbolType(marker.type);
  marker.symbolSidc2525B = resolveSymbolSidc2525B(marker.type);
  marker.symbolSidc2525D = resolveSymbolSidc2525D(marker.type);
  return marker;
}

function applySymbolIcon(marker) {
  if (!marker || typeof marker !== "object") return marker;
  enrichMarkerSymbol(marker);
  if (!marker.milSymbol) return marker;

  const hasCustomIcon =
    marker.iconSource === "path" || marker.iconSource === "usericon";
  if (hasCustomIcon) return marker;

  marker.iconId = symbolIconId(marker.type);
  marker.iconSource = "symbol2525";
  return marker;
}

module.exports = {
  ensureType2525,
  symbolIconId,
  parseSymbolIconId,
  resolveSymbolSidc2525B,
  resolveSymbolSidc2525D,
  isMilSymbolType,
  renderSymbolPng,
  enrichMarkerSymbol,
  applySymbolIcon,
};
