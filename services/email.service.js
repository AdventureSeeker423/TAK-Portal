/**
 * services/email.service.js
 *
 * SMTP groundwork.
 * - Controlled by EMAIL_ENABLED (boolean)
 * - Currently supports EMAIL_PROVIDER=smtp
 * - Provides a simple sendMail(...) helper
 *
 * NOTE: TLS certificate validation is intentionally DISABLED for SMTP
 * to support servers whose certificate name does not match SMTP_HOST.
 * This is insecure on untrusted networks (MITM risk).
 *
 * This module is intentionally not wired into user flows yet.
 */

const nodemailer = require("nodemailer");
const { getBool, getInt, getString } = require("./env");

function parseAddressList(value) {
  const s = String(value || "").trim();
  if (!s) return [];
  // Support comma or semicolon-separated lists
  return s
    .split(/[;,]/g)
    .map((x) => String(x).trim())
    .filter(Boolean);
}

function isEmailEnabled() {
  return getBool("EMAIL_ENABLED", false);
}

function getEmailProvider() {
  return (getString("EMAIL_PROVIDER", "smtp") || "smtp").toLowerCase();
}

function getSmtpConfig() {
  return {
    host: getString("SMTP_HOST", ""),
    port: getInt("SMTP_PORT", 587),
    secure: getBool("SMTP_SECURE", false),
    user: getString("SMTP_USER", ""),
    pass: getString("SMTP_PASS", ""),
    from: getString("SMTP_FROM", ""),
    alwaysCc: getString("EMAIL_ALWAYS_CC", ""),
    // Back-compat / optional: always BCC these recipients
    sendCopyTo: getString("EMAIL_SEND_COPY_TO", ""),
    failHard: getBool("EMAIL_FAIL_HARD", false),
  };
}

let _transport = null;
let _transportFingerprint = null;

function smtpTransportFingerprint(cfg) {
  return JSON.stringify({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    user: cfg.user,
    pass: cfg.pass,
  });
}

function closeTransportAsync(transport) {
  if (!transport || typeof transport.close !== "function") return;
  Promise.resolve(transport.close()).catch((err) => {
    console.warn("[EMAIL] transport close failed:", err?.message || err);
  });
}

function getTransport() {
  const provider = getEmailProvider();
  if (provider !== "smtp") {
    throw new Error(`Unsupported EMAIL_PROVIDER: ${provider}`);
  }

  const cfg = getSmtpConfig();
  if (!cfg.host) {
    throw new Error("EMAIL_ENABLED is true but SMTP_HOST is empty");
  }
  if (!cfg.from) {
    throw new Error("EMAIL_ENABLED is true but SMTP_FROM is empty");
  }

  const fingerprint = smtpTransportFingerprint(cfg);
  if (_transport && _transportFingerprint === fingerprint) {
    return _transport;
  }

  if (_transport) {
    closeTransportAsync(_transport);
    _transport = null;
    _transportFingerprint = null;
  }

  const auth = cfg.user
    ? {
        user: cfg.user,
        pass: cfg.pass,
      }
    : undefined;

  _transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth,

    // HARD OVERRIDE: disable TLS certificate/hostname validation
    // (fixes: "Hostname/IP does not match certificate's altnames")
    tls: {
      rejectUnauthorized: false,
    },
  });
  _transportFingerprint = fingerprint;

  return _transport;
}

const EMAIL_FORM_KEYS = [
  "EMAIL_ENABLED",
  "EMAIL_GROUP_CHANGES_ENABLED",
  "EMAIL_PROVIDER",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
  "EMAIL_ALWAYS_CC",
  "EMAIL_SEND_COPY_TO",
  "EMAIL_FAIL_HARD",
];

function mergeEmailFormSettings(baseSettings, bodySettings) {
  const merged = { ...(baseSettings || {}) };
  const body = bodySettings || {};
  EMAIL_FORM_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      merged[key] = body[key];
    }
  });
  return merged;
}

async function sendMail({ to, subject, text, html, cc, bcc, attachments }) {
  if (!isEmailEnabled()) {
    return { sent: false, skipped: true };
  }

  const cfg = getSmtpConfig();

  const mail = {
    from: cfg.from,
    to,
    subject,
    text,
    html,
  };

  if (attachments && Array.isArray(attachments) && attachments.length) {
    mail.attachments = attachments;
  }

  // Always-CC list (comma-separated)
  const alwaysCc = parseAddressList(cfg.alwaysCc);
  const ccList = [...alwaysCc, ...parseAddressList(cc)];
  if (ccList.length) mail.cc = ccList.join(",");

  // Optional quality-of-life: always BCC a testing or audit inbox list
  const bccList = [
    ...parseAddressList(cfg.sendCopyTo),
    ...parseAddressList(bcc),
  ];
  if (bccList.length) mail.bcc = bccList.join(",");

  try {
    const transport = getTransport();
    const info = await transport.sendMail(mail);
    return { sent: true, skipped: false, info };
  } catch (err) {
    if (cfg.failHard) throw err;
    console.error("[EMAIL] send failed:", err?.message || err);
    return { sent: false, skipped: false, error: err?.message || String(err) };
  }
}

module.exports = {
  isEmailEnabled,
  getEmailProvider,
  getSmtpConfig,
  mergeEmailFormSettings,
  sendMail,
};
