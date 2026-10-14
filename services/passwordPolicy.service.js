const settingsSvc = require("./settings.service");

/** Any non-alphanumeric character counts as a symbol. */
const SYMBOL_REGEX = /[^A-Za-z0-9]/
const UPPER_REGEX = /[A-Z]/g;
const LOWER_REGEX = /[a-z]/g;
const NUMBER_REGEX = /[0-9]/g;
const SYMBOL_GLOBAL_REGEX = /[^A-Za-z0-9]/g;

const DEFAULTS = {
  minLength: 12,
  requireUppercase: true,
  uppercaseCount: 1,
  requireLowercase: true,
  lowercaseCount: 1,
  requireNumber: true,
  numberCount: 1,
  requireSymbol: true,
  symbolCount: 1,
};

function parseBool(raw, fallback) {
  const v = String(raw == null ? "" : raw)
    .trim()
    .toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
}

function parsePositiveInt(raw, fallback, { min = 1, max = 128 } = {}) {
  const n = parseInt(String(raw == null ? "" : raw).trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function countMatches(pwd, regex) {
  const re = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
  return (String(pwd || "").match(re) || []).length;
}

function getPolicy(settings) {
  const cfg =
    settings && typeof settings === "object"
      ? settings
      : settingsSvc.getSettings
        ? settingsSvc.getSettings() || {}
        : {};

  return {
    minLength: parsePositiveInt(
      cfg.PASSWORD_POLICY_MIN_LENGTH,
      DEFAULTS.minLength
    ),
    requireUppercase: parseBool(
      cfg.PASSWORD_POLICY_REQUIRE_UPPERCASE,
      DEFAULTS.requireUppercase
    ),
    uppercaseCount: parsePositiveInt(
      cfg.PASSWORD_POLICY_UPPERCASE_COUNT,
      DEFAULTS.uppercaseCount
    ),
    requireLowercase: parseBool(
      cfg.PASSWORD_POLICY_REQUIRE_LOWERCASE,
      DEFAULTS.requireLowercase
    ),
    lowercaseCount: parsePositiveInt(
      cfg.PASSWORD_POLICY_LOWERCASE_COUNT,
      DEFAULTS.lowercaseCount
    ),
    requireNumber: parseBool(
      cfg.PASSWORD_POLICY_REQUIRE_NUMBER,
      DEFAULTS.requireNumber
    ),
    numberCount: parsePositiveInt(
      cfg.PASSWORD_POLICY_NUMBER_COUNT,
      DEFAULTS.numberCount
    ),
    requireSymbol: parseBool(
      cfg.PASSWORD_POLICY_REQUIRE_SYMBOL,
      DEFAULTS.requireSymbol
    ),
    symbolCount: parsePositiveInt(
      cfg.PASSWORD_POLICY_SYMBOL_COUNT,
      DEFAULTS.symbolCount
    ),
  };
}

function plural(n, singular, pluralForm) {
  return n === 1 ? singular : pluralForm || `${singular}s`;
}

function labeledCount(n, singular, pluralForm) {
  return `${n} ${plural(n, singular, pluralForm)}`;
}

function shortLabeledCount(n, label) {
  return n === 1 ? label : `${n} ${label}`;
}

function requirementParts(policy) {
  const p = policy || getPolicy();
  const parts = [`at least ${p.minLength} characters`];
  if (p.requireLowercase) {
    parts.push(labeledCount(p.lowercaseCount, "lowercase letter"));
  }
  if (p.requireUppercase) {
    parts.push(labeledCount(p.uppercaseCount, "uppercase letter"));
  }
  if (p.requireNumber) {
    parts.push(labeledCount(p.numberCount, "number"));
  }
  if (p.requireSymbol) {
    parts.push(labeledCount(p.symbolCount, "symbol"));
  }
  return parts;
}

function shortRequirementList(policy) {
  const p = policy || getPolicy();
  const bits = [];
  if (p.requireUppercase) {
    bits.push(shortLabeledCount(p.uppercaseCount, "upper"));
  }
  if (p.requireLowercase) {
    bits.push(shortLabeledCount(p.lowercaseCount, "lower"));
  }
  if (p.requireNumber) {
    bits.push(shortLabeledCount(p.numberCount, "number"));
  }
  if (p.requireSymbol) {
    bits.push(shortLabeledCount(p.symbolCount, "symbol"));
  }
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

/** HTML5 pattern lookahead for at least n matches of a character class. */
function countLookahead(notClass, matchClass, n) {
  return `(?=(?:${notClass}*${matchClass}){${n}})`;
}

function htmlPattern(policy) {
  const p = policy || getPolicy();
  const looks = [];
  if (p.requireUppercase) {
    looks.push(countLookahead("[^A-Z]", "[A-Z]", p.uppercaseCount));
  }
  if (p.requireLowercase) {
    looks.push(countLookahead("[^a-z]", "[a-z]", p.lowercaseCount));
  }
  if (p.requireNumber) {
    looks.push(countLookahead("[^0-9]", "[0-9]", p.numberCount));
  }
  if (p.requireSymbol) {
    looks.push(countLookahead("[A-Za-z0-9]", "[^A-Za-z0-9]", p.symbolCount));
  }
  return `${looks.join("")}.{${p.minLength},}`;
}

function csvBulletList(policy) {
  const p = policy || getPolicy();
  const lines = [`     - at least ${p.minLength} characters`];
  if (p.requireLowercase) {
    lines.push(
      `     - at least ${labeledCount(p.lowercaseCount, "lowercase letter")}`
    );
  }
  if (p.requireUppercase) {
    lines.push(
      `     - at least ${labeledCount(p.uppercaseCount, "uppercase letter")}`
    );
  }
  if (p.requireNumber) {
    lines.push(`     - at least ${labeledCount(p.numberCount, "number")}`);
  }
  if (p.requireSymbol) {
    lines.push(`     - at least ${labeledCount(p.symbolCount, "symbol")}`);
  }
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
  if (policy.requireLowercase) {
    const n = countMatches(pwd, LOWER_REGEX);
    if (n < policy.lowercaseCount) {
      return `Password must contain at least ${labeledCount(
        policy.lowercaseCount,
        "lowercase letter"
      )}.`;
    }
  }
  if (policy.requireUppercase) {
    const n = countMatches(pwd, UPPER_REGEX);
    if (n < policy.uppercaseCount) {
      return `Password must contain at least ${labeledCount(
        policy.uppercaseCount,
        "uppercase letter"
      )}.`;
    }
  }
  if (policy.requireNumber) {
    const n = countMatches(pwd, NUMBER_REGEX);
    if (n < policy.numberCount) {
      return `Password must contain at least ${labeledCount(
        policy.numberCount,
        "number"
      )}.`;
    }
  }
  if (policy.requireSymbol) {
    const n = countMatches(pwd, SYMBOL_GLOBAL_REGEX);
    if (n < policy.symbolCount) {
      return `Password must contain at least ${labeledCount(
        policy.symbolCount,
        "symbol"
      )}.`;
    }
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
      uppercaseCount: policy.uppercaseCount,
      requireLowercase: policy.requireLowercase,
      lowercaseCount: policy.lowercaseCount,
      requireNumber: policy.requireNumber,
      numberCount: policy.numberCount,
      requireSymbol: policy.requireSymbol,
      symbolCount: policy.symbolCount,
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
