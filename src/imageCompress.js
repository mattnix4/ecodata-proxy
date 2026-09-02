const sharp = require("sharp");

const QUALITY = 20;
const MAX_WIDTH = 800;

const IMAGE_CONTENT_TYPES = ["image/jpeg", "image/png", "image/gif"];

function isCompressibleImage(contentType) {
  if (!contentType) return false;
  const ct = contentType.split(";")[0].trim().toLowerCase();
  return IMAGE_CONTENT_TYPES.includes(ct);
}

/**
 * Compresse un buffer image dans son format d'origine, redimensionné à 800px max.
 * Retourne { buffer, contentType } ou lève une erreur — à l'appelant de
 * décider du fallback (servir l'original en cas d'échec).
 */
async function compressImage(buffer, contentType) {
  const normalizedType = (contentType || "").split(";")[0].trim().toLowerCase();
  const pipeline = sharp(buffer, { animated: normalizedType === "image/gif" })
    .resize({ width: MAX_WIDTH, withoutEnlargement: true });

  if (normalizedType === "image/jpeg") {
    return { buffer: await pipeline.jpeg({ quality: QUALITY }).toBuffer(), contentType: normalizedType };
  }
  if (normalizedType === "image/png") {
    return { buffer: await pipeline.png({ quality: QUALITY, palette: true }).toBuffer(), contentType: normalizedType };
  }
  if (normalizedType === "image/gif") {
    return { buffer: await pipeline.gif({ effort: 3 }).toBuffer(), contentType: normalizedType };
  }
  throw new Error(`Type d'image non pris en charge: ${normalizedType || "inconnu"}`);
}

module.exports = { isCompressibleImage, compressImage };
