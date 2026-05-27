/**
 * services/emailTemplates.service.js
 *
 * Very small HTML template loader for notification emails.
 *
 * Templates live in: <projectRoot>/email_templates
 *
 * Usage:
 *   const { renderTemplate } = require("./emailTemplates.service");
 *   const html = renderTemplate("user_created.html", { username: "jsmith" });
 *
 * Placeholders:
 *   {{username}}
 *   {{displayName}}
 *   {{groupsCsv}}
 *
 * You can introduce more placeholders in the HTML files without touching JS.
 */

const fs = require("fs");
const path = require("path");
const settingsSvc = require("./settings.service");

function getTemplatesDir() {
  // This file lives in /services; templates live in /email_templates
  return path.join(__dirname, "..", "email_templates");
}

function readBuiltinTemplateFile(filename) {
  const safeName = path.basename(String(filename || ""));
  const fullPath = path.join(getTemplatesDir(), safeName);
  return fs.readFileSync(fullPath, "utf8");
}

function isDeprecatedGroupsUpdatedTemplate(html) {
  const source = String(html || "");
  if (!source.trim()) return false;
  const hasNewPlaceholders =
    /\{\{\s*addedGroupsCsv\s*\}\}/i.test(source) ||
    /\{\{\s*removedGroupsCsv\s*\}\}/i.test(source);
  if (hasNewPlaceholders) return false;
  return (
    /\{\{\s*beforeGroupsCsv\s*\}\}/i.test(source) ||
    /\{\{\s*afterGroupsCsv\s*\}\}/i.test(source) ||
    /Previous\s+Groups/i.test(source) ||
    /New\s+Groups/i.test(source)
  );
}

/**
 * Load a template, preferring any override stored in settings.json:
 *
 * settings.EMAIL_TEMPLATES_OVERRIDES = {
 *   "user_created_password_set.html": "<custom html>",
 *   "user_reenabled.html": "<custom html>",
 *   ...
 * }
 *
 * If no override exists for the given filename, we fall back to the
 * built-in file in /email_templates.
 */
function loadTemplateFile(filename) {
  // First, see if there is an override stored in settings (EMAIL_TEMPLATES_OVERRIDES).
  // The overrides object is a simple map: { "<filename>.html": "<custom html>" }.
  try {
    if (settingsSvc && typeof settingsSvc.getSettings === "function") {
      const settings = settingsSvc.getSettings() || {};
      const overrides = settings.EMAIL_TEMPLATES_OVERRIDES;
      if (overrides && typeof overrides === "object") {
        const key = String(filename || "");
        if (Object.prototype.hasOwnProperty.call(overrides, key)) {
          const overrideHtml = overrides[key];
          if (typeof overrideHtml === "string" && overrideHtml.trim()) {
            if (
              key === "groups_updated.html" &&
              isDeprecatedGroupsUpdatedTemplate(overrideHtml)
            ) {
              console.warn(
                "[emailTemplates] Ignoring deprecated groups_updated.html override (uses Previous/New Groups placeholders). Using built-in Added/Removed Groups template. Reset this template under Server Settings → Email Templates to customize."
              );
            } else {
              return overrideHtml;
            }
          }
        }
      }
    }
  } catch (err) {
    console.error(
      "[emailTemplates] Failed to read overrides from settings:",
      err
    );
  }

  return readBuiltinTemplateFile(filename);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render a template with the given variables.
 *
 * - `{{key}}`    → HTML-escaped replacement
 * - `{{{key}}}`  → raw replacement
 */
function renderTemplate(filename, vars) {
  const tpl = loadTemplateFile(filename);
  const data = vars && typeof vars === "object" ? vars : {};

  // Replace {{key}} with escaped value; allow raw HTML via {{{key}}}
  return tpl
    .replace(/\{\{\{\s*([a-zA-Z0-9_]+)\s*\}\}\}/g, (_, k) =>
      String(data[k] ?? "")
    )
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => escapeHtml(data[k]));
}

/**
 * Extremely small "HTML → text" helper so we can send a text alternative
 * without bringing in an external dependency.
 */
function htmlToText(html) {
  // Super-simple fallback text conversion.
  // Keeps this dependency-free; you can improve later if desired.
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

module.exports = {
  renderTemplate,
  htmlToText,
  getTemplatesDir,
};
