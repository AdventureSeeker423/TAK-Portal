"use strict";

const crypto = require("crypto");

const MAGIC = Buffer.from("TAKBACKUP1");
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function isEncryptedBackup(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < MAGIC.length) return false;
  return buf.subarray(0, MAGIC.length).equals(MAGIC);
}

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase || ""), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
}

function encryptBuffer(plain, passphrase) {
  const pwd = String(passphrase || "");
  if (!pwd) throw new Error("Passphrase is required to encrypt a backup");
  if (!Buffer.isBuffer(plain)) throw new Error("encryptBuffer expects a Buffer");
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(pwd, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, iv, tag, ciphertext]);
}

function decryptBuffer(enc, passphrase) {
  const pwd = String(passphrase || "");
  if (!pwd) throw new Error("Passphrase is required to decrypt this backup");
  if (!Buffer.isBuffer(enc)) throw new Error("decryptBuffer expects a Buffer");
  if (!isEncryptedBackup(enc)) throw new Error("Not an encrypted TAK Portal backup");
  const min = MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN;
  if (enc.length < min) throw new Error("Encrypted backup is truncated");
  let offset = MAGIC.length;
  const salt = enc.subarray(offset, offset + SALT_LEN);
  offset += SALT_LEN;
  const iv = enc.subarray(offset, offset + IV_LEN);
  offset += IV_LEN;
  const tag = enc.subarray(offset, offset + TAG_LEN);
  offset += TAG_LEN;
  const ciphertext = enc.subarray(offset);
  const key = deriveKey(pwd, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (e) {
    throw new Error("Invalid passphrase or corrupt backup");
  }
}

module.exports = {
  MAGIC,
  isEncryptedBackup,
  encryptBuffer,
  decryptBuffer,
};
