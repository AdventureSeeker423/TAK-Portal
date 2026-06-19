(function (global) {
  "use strict";

  const COT2525_RE = /^a-[PUAFNSHJKOXpuafnshjkox]-[PAGSUFXZ](-\w+)*$/;

  function is2525Convertable(cotType) {
    return COT2525_RE.test(String(cotType || "").trim());
  }

  function cotTypeTo2525B(cotType) {
    const t = String(cotType || "").trim();
    if (!is2525Convertable(t)) return null;

    const m2525bChars = t.substring(4).replace(/[^A-Z0-9]+/gi, "").toUpperCase();
    const m2525bBattleDim = m2525bChars.substring(0, 1);
    const cotAffiliation = t.substring(2, 3);
    const m2525bAffiliation =
      cotAffiliation === "o" || cotAffiliation === "x" ? "U" : cotAffiliation.toUpperCase();
    const m2525bFuncId =
      m2525bChars.length > 1
        ? m2525bChars.substring(1).padEnd(6, "-").substring(0, 6)
        : "------";
    return "S" + m2525bAffiliation + m2525bBattleDim + "P" + m2525bFuncId + "-----";
  }

  function renderMilSymbolCanvas(cotType, options) {
    if (!global.ms || !is2525Convertable(cotType)) return null;
    const sidc = cotTypeTo2525B(cotType);
    if (!sidc) return null;

    const opts = options || {};
    const sym = new global.ms.Symbol(sidc, {
      size: opts.size || 46,
      direction: Number.isFinite(opts.course) ? opts.course : undefined,
      outlineColor: "#0b0f14",
      outlineWidth: 4,
    });

    try {
      return sym.asCanvas();
    } catch (_) {
      return null;
    }
  }

  global.MapSymbology = {
    is2525Convertable,
    cotTypeTo2525B,
    renderMilSymbolCanvas,
  };
})(typeof window !== "undefined" ? window : globalThis);
