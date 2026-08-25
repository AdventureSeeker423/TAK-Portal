/**
 * Strip characters that render as tofu / boxes in map labels and TAK clients.
 * TAK Aware (iOS) often emits U+FFFC (object replacement) where spaces or
 * rich-text attachments were in the callsign.
 */
function sanitizeCallsign(raw) {
  let s = String(raw == null ? "" : raw);
  s = s.replace(/[\uFFFC\uFFFD]/g, " ");
  s = s.replace(
    /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g,
    ""
  );
  return s.replace(/\s+/g, " ").trim();
}

module.exports = { sanitizeCallsign };
