/**
 * MIL-STD-2525 symbol SIDC resolution for map markers.
 */
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

function enrichMarkerSymbol(marker) {
  if (!marker || typeof marker !== "object") return marker;
  marker.symbolSidc2525D = resolveSymbolSidc2525D(marker.type);
  return marker;
}

module.exports = {
  ensureType2525,
  resolveSymbolSidc2525D,
  isMilSymbolType,
  enrichMarkerSymbol,
};
