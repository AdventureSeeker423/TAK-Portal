const crypto = require("crypto");
const fs = require("fs");
const settingsSvc = require("./settings.service");

const KEY_NAME = "MUTUAL_AID_ENCRYPTION_KEY";

function generateKeyHex() {
  return crypto.randomBytes(32).toString("hex");
}

function getKeyBuffer({ allowCreate = false } = {}) {
  // Settings are cached independently by web and worker. The persisted key is
  // authoritative, including when a worker started before web initialization.
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsSvc.SETTINGS_PATH, "utf8"));
  } catch (_) {
    throw new Error("Unable to read encryption key settings; restore settings.json before retrying.");
  }
  let hex = String(settings?.[KEY_NAME] || "").trim();
  if (hex && !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("Invalid persisted encryption key; restore it before retrying.");
  }
  if (!hex) {
    // The existing single web process initializes the key. Workers only consume
    // it; decrypting existing ciphertext must never create a replacement key.
    if (!allowCreate) {
      throw new Error("Shared encryption key is missing; initialize it in the web process first.");
    }
    hex = generateKeyHex();
    settingsSvc.saveSettings({ ...settings, [KEY_NAME]: hex });
  }
  return Buffer.from(hex, "hex");
}

function encryptSecret(plaintext) {
  const text = String(plaintext || "");
  if (!text) return "";
  const key = getKeyBuffer();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

function decryptSecret(stored) {
  const raw = String(stored || "");
  if (!raw) return "";
  if (!raw.startsWith("v1:")) return raw;
  const parts = raw.split(":");
  if (parts.length !== 4) throw new Error("Invalid encrypted secret.");
  const key = getKeyBuffer();
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const data = Buffer.from(parts[3], "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

module.exports = {
  KEY_NAME,
  encryptSecret,
  decryptSecret,
  getKeyBuffer,
};
