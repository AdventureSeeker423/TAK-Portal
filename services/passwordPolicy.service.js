const settingsSvc = require("./settings.service");

/** Any non-alphanumeric character counts as a symbol. */
const SYMBOL_REGEX = /[^A-Za-z0-9]/

const DEFAULTS = {
  minLength: 12,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSymbol: true,
};

function parseBool(raw, fallback) {
  const v = String(raw == null ? "" : raw)
    .trim()
    .toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
}

function parseMinLength(raw) {
  const n = parseInt(String(raw == null ? "" : raw).trim(), 10);
  if (!Number.isFinite(n)) return DEFAULTS.minLength;
  return Math.min(128, Math.max(1, n));
}

function getPolicy(settings) {
  const cfg =
    settings && typeof settings === "object"
      ? settings
      : settingsSvc.getSettings
        ? settingsSvc.getSettings() || {}
        : {};

  return {
    minLength: parseMinLength(cfg.PASSWORD_POLICY_MIN_LENGTH),
    requireUppercase: parseBool(
      cfg.PASSWORD_POLICY_REQUIRE_UPPERCASE,
      DEFAULTS.requireUppercase
    ),
    requireLowercase: parseBool(
      cfg.PASSWORD_POLICY_REQUIRE_LOWERCASE,
      DEFAULTS.requireLowercase
    ),
    requireNumber: parseBool(
      cfg.PASSWORD_POLICY_REQUIRE_NUMBER,
      DEFAULTS.requireNumber
    ),
    requireSymbol: parseBool(
      cfg.PASSWORD_POLICY_REQUIRE_SYMBOL,
      DEFAULTS.requireSymbol
    ),
  };
}

function requirementParts(policy) {
  const p = policy || getPolicy();
  const parts = [`at least ${p.minLength} characters`];
  if (p.requireLowercase) parts.push("1 lowercase letter");
  if (p.requireUppercase) parts.push("1 uppercase letter");
  if (p.requireNumber) parts.push("1 number");
  if (p.requireSymbol) parts.push("1 symbol");
  return parts;
}

function shortRequirementList(policy) {
  const p = policy || getPolicy();
  const bits = [];
  if (p.requireUppercase) bits.push("upper");
  if (p.requireLowercase) bits.push("lower");
  if (p.requireNumber) bits.push("number");
  if (p.requireSymbol) bits.push("symbol");
  if (!bits.length) return `Min ${p.minLength} characters`;
  if (bits.length === 1) return `Min ${p.minLength} characters: ${bits[0]}`;
  if (bits.length === 2) {
    return `Min ${p.minLength} characters: ${bits[0]} and ${bits[1]}`;
  }
  return `Min ${p.minLength} characters: ${bits.slice(0, -1).join(", ")}, and ${
    bits[bits.length - 1]
  }`;
}

function titleText(policy) {
  const parts = requirementParts(policy);
  if (parts.length === 1) {
    return `Password must contain a minimum of ${parts[0]}`;
  }
  return `Password must contain a minimum of ${parts[0]}, ${parts
    .slice(1)
    .join(", ")}`;
}

function errorMessage(policy, { allowBlank = false } = {}) {
  const parts = requirementParts(policy);
  let msg;
  if (parts.length === 1) {
    msg = `Password must be ${parts[0]}`;
  } else {
    msg = `Password must be ${parts[0]} and include ${parts
      .slice(1)
      .join(", ")}`;
  }
  if (allowBlank) msg += ", or be left blank";
  return msg + ".";
}

function htmlPattern(policy) {
  const p = policy || getPolicy();
  const looks = [];
  if (p.requireUppercase) looks.push("(?=.*[A-Z])");
  if (p.requireLowercase) looks.push("(?=.*[a-z])");
  if (p.requireNumber) looks.push("(?=.*\\d)");
  if (p.requireSymbol) looks.push("(?=.*[^A-Za-z0-9])");
  return `${looks.join("")}.{${p.minLength},}`;
}

function csvBulletList(policy) {
  const p = policy || getPolicy();
  const lines = [`     - at least ${p.minLength} characters`];
  if (p.requireLowercase) lines.push("     - at least 1 lowercase letter");
  if (p.requireUppercase) lines.push("     - at least 1 uppercase letter");
  if (p.requireNumber) lines.push("     - at least 1 number");
  if (p.requireSymbol) lines.push("     - at least 1 symbol");
  return lines.join("\n");
}

/**
 * Validate a password against the configured policy.
 * @returns {string|null} Error message, or null if valid.
 */
function validatePassword(password, settings) {
  const policy = getPolicy(settings);
  const pwd = String(password || "");
  if (pwd.length < policy.minLength) {
    return `Password must be at least ${policy.minLength} characters.`;
  }
  if (policy.requireLowercase && !/[a-z]/.test(pwd)) {
    return "Password must contain a lowercase letter.";
  }
  if (policy.requireUppercase && !/[A-Z]/.test(pwd)) {
    return "Password must contain an uppercase letter.";
  }
  if (policy.requireNumber && !/[0-9]/.test(pwd)) {
    return "Password must contain a number.";
  }
  if (policy.requireSymbol && !SYMBOL_REGEX.test(pwd)) {
    return "Password must contain a symbol.";
  }
  return null;
}

/** View + client payload used by EJS forms. */
function getViewModel(settings) {
  const policy = getPolicy(settings);
  return {
    ...policy,
    placeholder: shortRequirementList(policy),
    title: titleText(policy),
    pattern: htmlPattern(policy),
    errorOptional: errorMessage(policy, { allowBlank: true }),
    errorRequired: errorMessage(policy, { allowBlank: false }),
    client: {
      minLength: policy.minLength,
      requireUppercase: policy.requireUppercase,
      requireLowercase: policy.requireLowercase,
      requireNumber: policy.requireNumber,
      requireSymbol: policy.requireSymbol,
      errorOptional: errorMessage(policy, { allowBlank: true }),
      errorRequired: errorMessage(policy, { allowBlank: false }),
    },
  };
}

module.exports = {
  DEFAULTS,
  SYMBOL_REGEX,
  getPolicy,
  getViewModel,
  validatePassword,
  requirementParts,
  shortRequirementList,
  titleText,
  errorMessage,
  htmlPattern,
  csvBulletList,
};
