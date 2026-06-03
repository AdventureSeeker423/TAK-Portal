/**
 * Center logo overlay for QR PNGs — preserves source aspect ratio (no stretch).
 */
const Jimp = require("jimp");

/**
 * @param {Buffer} pngBuffer
 * @param {string} logoFsPath
 * @param {{ logoRatio?: number, logoPadRatio?: number }} [options]
 * @returns {Promise<Buffer>}
 */
async function addLogoToQrPng(pngBuffer, logoFsPath, options = {}) {
  try {
    if (!logoFsPath) return pngBuffer;

    const logoRatio = Number(options.logoRatio) > 0 ? Number(options.logoRatio) : 0.25;
    const padRatio =
      Number(options.logoPadRatio) >= 0 ? Number(options.logoPadRatio) : 0.04;

    const [qrImage, logoImageOriginal] = await Promise.all([
      Jimp.read(pngBuffer),
      Jimp.read(logoFsPath),
    ]);

    const qrWidth = qrImage.getWidth();
    const qrHeight = qrImage.getHeight();

    const badgeMax = Math.floor(Math.min(qrWidth, qrHeight) * logoRatio);
    const padding = Math.max(2, Math.floor(badgeMax * padRatio));
    const innerMax = Math.max(1, badgeMax - padding * 2);

    const logoImage = logoImageOriginal.clone();
    const origW = logoImage.getWidth();
    const origH = logoImage.getHeight();

    // Fit inside inner area; never upscale (avoids soft stretch artifacts).
    if (origW > innerMax || origH > innerMax) {
      logoImage.contain(innerMax, innerMax);
    }

    const lw = logoImage.getWidth();
    const lh = logoImage.getHeight();
    const bgWidth = lw + padding * 2;
    const bgHeight = lh + padding * 2;

    const bgX = Math.floor((qrWidth - bgWidth) / 2);
    const bgY = Math.floor((qrHeight - bgHeight) / 2);

    qrImage.scan(bgX, bgY, bgWidth, bgHeight, function (x, y, idx) {
      this.bitmap.data[idx + 0] = 255;
      this.bitmap.data[idx + 1] = 255;
      this.bitmap.data[idx + 2] = 255;
      this.bitmap.data[idx + 3] = 255;
    });

    const logoX = bgX + Math.floor((bgWidth - lw) / 2);
    const logoY = bgY + Math.floor((bgHeight - lh) / 2);

    qrImage.composite(logoImage, logoX, logoY);

    return await qrImage.getBufferAsync(Jimp.MIME_PNG);
  } catch (err) {
    console.error("[QR LOGO] Failed to add logo to QR:", err);
    return pngBuffer;
  }
}

module.exports = {
  addLogoToQrPng,
};
