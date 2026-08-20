/**
 * Extract package metadata and optional icon from an Android APK (ZIP).
 * Uses unzipper (already a dependency); no aapt required.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const unzipper = require("unzipper");

const RES_STRING = 0x01;
const RES_XML_START_ELEMENT = 0x0102;
const CHUNK_STRING_POOL = 0x0001;
const CHUNK_RESOURCE_MAP = 0x0180;
const CHUNK_START_NAMESPACE = 0x0100;
const CHUNK_END_NAMESPACE = 0x0101;
const CHUNK_END_ELEMENT = 0x0103;
const CHUNK_CDATA = 0x0104;

function readU16(buf, offset) {
  return buf.readUInt16LE(offset);
}

function readU32(buf, offset) {
  return buf.readUInt32LE(offset);
}

function decodeUtf16le(buf, start, charCount) {
  const byteLen = charCount * 2;
  return buf.slice(start, start + byteLen).toString("utf16le");
}

function decodeUtf8(buf, start, byteLen) {
  return buf.slice(start, start + byteLen).toString("utf8");
}

/**
 * Parse Android binary XML string pool.
 */
function parseStringPool(buf, poolOffset) {
  const stringCount = readU32(buf, poolOffset + 8);
  const flags = readU32(buf, poolOffset + 16);
  const stringsStart = readU32(buf, poolOffset + 20);
  const isUtf8 = (flags & (1 << 8)) !== 0;
  const offsetsBase = poolOffset + 28;
  const strings = [];

  for (let i = 0; i < stringCount; i++) {
    const rel = readU32(buf, offsetsBase + i * 4);
    const abs = poolOffset + stringsStart + rel;
    if (isUtf8) {
      // UTF-8: u16 charLen (may be 1-2 bytes encoded), then u16 byteLen, then bytes, then 0
      let p = abs;
      // skip char length (encoded)
      let charLen = buf[p++];
      if (charLen & 0x80) {
        charLen = ((charLen & 0x7f) << 8) | buf[p++];
      }
      let byteLen = buf[p++];
      if (byteLen & 0x80) {
        byteLen = ((byteLen & 0x7f) << 8) | buf[p++];
      }
      strings.push(decodeUtf8(buf, p, byteLen));
    } else {
      const charLen = readU16(buf, abs);
      strings.push(decodeUtf16le(buf, abs + 2, charLen));
    }
  }
  return strings;
}

function getString(strings, index) {
  if (index < 0 || index === 0xffffffff || index >= strings.length) return "";
  return strings[index] || "";
}

/**
 * Walk binary AndroidManifest.xml and pull key attributes.
 */
function parseAndroidManifestBinary(buf) {
  if (!buf || buf.length < 8) return null;
  // File header: type(u16) headerSize(u16) fileSize(u32)
  let offset = 8;
  let strings = [];
  const out = {
    packageName: "",
    versionName: "",
    versionCode: "",
    minSdk: "",
    label: "",
    description: "",
    pluginApi: "",
    iconPath: "",
  };

  while (offset + 8 <= buf.length) {
    const chunkType = readU16(buf, offset);
    const headerSize = readU16(buf, offset + 2);
    const chunkSize = readU32(buf, offset + 4);
    if (chunkSize < 8 || offset + chunkSize > buf.length) break;

    if (chunkType === CHUNK_STRING_POOL) {
      strings = parseStringPool(buf, offset);
    } else if (chunkType === RES_XML_START_ELEMENT || chunkType === 0x0102) {
      // startElement: ns, name, attributeStart, attributeSize, attributeCount, idIndex, classIndex, styleIndex
      if (headerSize >= 16 && chunkSize >= headerSize) {
        const nameIdx = readU32(buf, offset + 12);
        const elementName = getString(strings, nameIdx);
        const attributeStart = readU16(buf, offset + 16);
        const attributeSize = readU16(buf, offset + 18);
        const attributeCount = readU16(buf, offset + 20);
        const attrBase = offset + attributeStart;
        const attrs = {};
        for (let i = 0; i < attributeCount; i++) {
          const a = attrBase + i * (attributeSize || 20);
          if (a + 20 > offset + chunkSize) break;
          const attrNameIdx = readU32(buf, a + 4);
          const rawValueIdx = readU32(buf, a + 8);
          const valueType = buf[a + 15]; // data type at +12 structure: size(u16), res0(u8), dataType(u8), data(u32)
          // Actually Res_value: size u16, res0 u8, dataType u8, data u32 starting at a+12
          const dataType = buf[a + 15];
          const data = readU32(buf, a + 16);
          const attrName = getString(strings, attrNameIdx);
          let value = "";
          if (dataType === RES_STRING) {
            value = getString(strings, data);
          } else if (rawValueIdx !== 0xffffffff) {
            value = getString(strings, rawValueIdx);
          } else {
            value = String(data);
          }
          attrs[attrName] = value;
        }

        if (elementName === "manifest") {
          if (attrs.package) out.packageName = attrs.package;
          if (attrs.versionName) out.versionName = attrs.versionName;
          if (attrs.versionCode != null && attrs.versionCode !== "") {
            out.versionCode = String(attrs.versionCode);
          }
        } else if (elementName === "uses-sdk") {
          if (attrs.minSdkVersion) out.minSdk = String(attrs.minSdkVersion);
        } else if (elementName === "application") {
          if (attrs.label && !attrs.label.startsWith("@")) out.label = attrs.label;
          if (attrs.icon && attrs.icon.includes("/")) out.iconPath = attrs.icon.replace(/^@drawable\//, "");
          // icon may be resource id — handled via fallback scan below
        } else if (elementName === "meta-data") {
          const n = attrs.name || "";
          const v = attrs.value || "";
          if (n === "app_desc" || n === "plugin.description") out.description = v;
          if (n === "plugin-api" || n === "plugin.api") out.pluginApi = v;
        }
      }
    }

    offset += chunkSize;
  }

  return out;
}

/**
 * Fallback: scrape ASCII/UTF-16 package/version strings from binary manifest.
 */
function scrapeManifestStrings(buf) {
  const text = buf.toString("utf8");
  const out = {};
  const pkg = text.match(/([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*){2,})/);
  // Prefer known atak plugin package patterns from UTF-16
  const utf16 = buf.toString("utf16le");
  const pkg16 = utf16.match(/com\.[a-zA-Z0-9_.]+/);
  if (pkg16) out.packageName = pkg16[0];
  else if (pkg) out.packageName = pkg[1];

  const ver16 = utf16.match(/(\d+\.\d+(?:\.\d+){0,3})/);
  if (ver16) out.versionName = ver16[1];
  return out;
}

async function readZipEntries(apkPath) {
  const directory = await unzipper.Open.file(apkPath);
  return directory.files || [];
}

async function readEntryBuffer(entry) {
  return entry.buffer();
}

/**
 * @param {string} apkPath
 * @returns {Promise<{
 *   packageName: string,
 *   versionName: string,
 *   versionCode: string,
 *   minSdk: string,
 *   label: string,
 *   description: string,
 *   pluginApi: string,
 *   iconPng: Buffer|null,
 *   sha256: string,
 *   size: number
 * }>}
 */
async function extractApkMetadata(apkPath) {
  const stat = fs.statSync(apkPath);
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(apkPath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  const sha256 = hash.digest("hex");

  const files = await readZipEntries(apkPath);
  const manifestEntry = files.find((f) => f.path === "AndroidManifest.xml");
  let meta = {
    packageName: "",
    versionName: "",
    versionCode: "",
    minSdk: "",
    label: "",
    description: "",
    pluginApi: "",
    iconPath: "",
  };

  if (manifestEntry) {
    const buf = await readEntryBuffer(manifestEntry);
    try {
      const parsed = parseAndroidManifestBinary(buf);
      if (parsed) meta = { ...meta, ...parsed };
    } catch (_) {
      /* fall through */
    }
    if (!meta.packageName || !meta.versionName) {
      const scraped = scrapeManifestStrings(buf);
      if (!meta.packageName && scraped.packageName) meta.packageName = scraped.packageName;
      if (!meta.versionName && scraped.versionName) meta.versionName = scraped.versionName;
    }
  }

  // Icon: prefer PNG under res/
  let iconPng = null;
  const pngCandidates = files
    .filter((f) => /\.png$/i.test(f.path) && /res\//i.test(f.path))
    .sort((a, b) => {
      // Prefer denser mipmaps / drawable-xxhdpi style paths
      const score = (p) => {
        let s = 0;
        if (/xxhdpi|xxxhdpi|hdpi/i.test(p)) s += 3;
        if (/mipmap/i.test(p)) s += 2;
        if (/icon/i.test(p)) s += 2;
        return s;
      };
      return score(b.path) - score(a.path);
    });

  if (meta.iconPath) {
    const match = files.find(
      (f) => f.path === meta.iconPath || f.path.endsWith("/" + meta.iconPath) || f.path.includes(meta.iconPath)
    );
    if (match && /\.png$/i.test(match.path)) {
      try {
        iconPng = await readEntryBuffer(match);
      } catch (_) {
        iconPng = null;
      }
    }
  }
  if (!iconPng && pngCandidates.length) {
    try {
      iconPng = await readEntryBuffer(pngCandidates[0]);
    } catch (_) {
      iconPng = null;
    }
  }

  return {
    packageName: meta.packageName || "",
    versionName: meta.versionName || "",
    versionCode: meta.versionCode || "",
    minSdk: meta.minSdk || "",
    label: meta.label || "",
    description: meta.description || "",
    pluginApi: meta.pluginApi || "",
    iconPng: iconPng && iconPng.length ? iconPng : null,
    sha256,
    size: stat.size,
  };
}

module.exports = {
  extractApkMetadata,
};
