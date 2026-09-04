const crypto = require("crypto");
const settingsSvc = require("./settings.service");

const KEY_NAME = "MUTUAL_AID_ENCRYPTION_KEY";

function generateKeyHex() {
  return crypto.randomBytes(32).toString("hex");
}

function getKeyBuffer() {
  let hex = String(settingsSvc.get(KEY_NAME, "") || "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    hex = generateKeyHex();
    try {
      settingsSvc.updateSettings({ [KEY_NAME]: hex });
    } catch (e) {
      console.warn("[crypto] failed to persist encryption key:", e?.message || e);
    }
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
  if (parts.length !== 4) return "";
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
