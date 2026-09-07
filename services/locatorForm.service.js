/**
 * Public locate form schema for live (non-TAK-CoreConfig) locators.
 */

const { ALLOWED_TEAM_COLORS } = require("./preferencePackage.service");

const DEFAULT_HEADING = "Share Location";
const DEFAULT_INTRO =
  "A responder has requested your location to aid in emergency response efforts. Please tap the button to start sharing your location and allow location services if prompted. PLEASE KEEP THIS PAGE OPEN AND DO NOT CLOSE UNTIL INSTRUCTED TO BY A RESPONDER.";

const FIELD_TYPES = ["firstName", "lastName", "message", "text", "choice"];
const BUILTIN_TYPES = new Set(["firstName", "lastName", "message"]);
const DEFAULT_LABELS = {
  firstName: "First Name",
  lastName: "Last Name",
  message: "Message",
  text: "Text",
  choice: "Choice",
};

function normalizeColor(raw) {
  const s = String(raw || "").trim();
  if (!s) return "Cyan";
  const found = ALLOWED_TEAM_COLORS.find((c) => c.toLowerCase() === s.toLowerCase());
  return found || "Cyan";
}

function newFieldId() {
  return `f_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeFieldType(raw) {
  const t = String(raw || "").trim();
  return FIELD_TYPES.includes(t) ? t : "";
}

function normalizeOptions(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split("\n") : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const s = String(item || "").trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s.slice(0, 120));
    if (out.length >= 24) break;
  }
  return out;
}

function normalizeForm(raw) {
  const heading =
    String(raw?.heading != null ? raw.heading : DEFAULT_HEADING).trim() || DEFAULT_HEADING;
  const intro =
    String(raw?.intro != null ? raw.intro : DEFAULT_INTRO).trim() || DEFAULT_INTRO;
  const seenBuiltin = new Set();
  const fields = [];
  const src = Array.isArray(raw?.fields) ? raw.fields : [];
  for (const item of src) {
    if (!item || typeof item !== "object") continue;
    const type = normalizeFieldType(item.type);
    if (!type) continue;
    if (BUILTIN_TYPES.has(type)) {
      if (seenBuiltin.has(type)) continue;
      seenBuiltin.add(type);
    }
    const id = String(item.id || "").trim() || newFieldId();
    const label =
      String(item.label || "").trim().slice(0, 80) || DEFAULT_LABELS[type] || "Field";
    const field = {
      id,
      type,
      label,
      required: !!item.required,
    };
    if (type === "choice") {
      field.options = normalizeOptions(item.options);
      if (!field.options.length) continue;
    }
    fields.push(field);
    if (fields.length >= 40) break;
  }
  return { heading, intro, fields };
}

function parseAnswers(body) {
  if (!body || typeof body !== "object") return {};
  if (body.answers && typeof body.answers === "object" && !Array.isArray(body.answers)) {
    const out = {};
    for (const [k, v] of Object.entries(body.answers)) {
      out[String(k)] = v == null ? "" : String(v).trim();
    }
    return out;
  }
  if (typeof body.answers === "string" && body.answers.trim()) {
    try {
      const parsed = JSON.parse(body.answers);
      return parseAnswers({ answers: parsed });
    } catch (_) {
      /* fall through */
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (!String(k).startsWith("answer_")) continue;
    out[String(k).slice(7)] = v == null ? "" : String(Array.isArray(v) ? v[0] : v).trim();
  }
  return out;
}

function answerForType(fields, answers, type) {
  const field = (fields || []).find((f) => f.type === type);
  if (!field) return "";
  return String(answers?.[field.id] || "").trim();
}

function validateAnswers(form, answers) {
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const src = answers && typeof answers === "object" ? answers : {};
  const cleaned = {};
  for (const field of fields) {
    const raw = src[field.id];
    const value = raw == null ? "" : String(raw).trim();
    if (field.required && !value) {
      return { error: `${field.label} is required.` };
    }
    if (field.type === "choice" && value) {
      const ok = (field.options || []).some(
        (o) => String(o).trim().toLowerCase() === value.toLowerCase()
      );
      if (!ok) return { error: `Invalid choice for ${field.label}.` };
    }
    cleaned[field.id] = value.slice(0, 2000);
  }
  return { answers: cleaned };
}

function formatLiveCallsign(title, form, answers) {
  const fields = form?.fields || [];
  const first = answerForType(fields, answers, "firstName");
  const last = answerForType(fields, answers, "lastName");
  if (first || last) {
    return last && first ? `${last}, ${first}` : last || first;
  }
  const t = String(title || "").trim() || "Missing Person";
  return `LOCATOR - ${t}`;
}

function formatLiveRemarks(form, answers) {
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const lines = [];
  for (const field of fields) {
    const value = String(answers?.[field.id] || "").trim();
    if (!value) continue;
    if (field.type === "message") lines.push(value);
    else lines.push(`${field.label}: ${value}`);
  }
  return lines.join("\n").slice(0, 4000);
}

module.exports = {
  ALLOWED_TEAM_COLORS,
  DEFAULT_HEADING,
  DEFAULT_INTRO,
  FIELD_TYPES,
  normalizeColor,
  normalizeForm,
  parseAnswers,
  validateAnswers,
  formatLiveCallsign,
  formatLiveRemarks,
  answerForType,
};
