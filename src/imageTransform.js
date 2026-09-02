const sharp = require("sharp");
const cache = require("./cache");
const { fetchWithTlsFallback } = require("./httpAgent");

const DEFAULT_QUALITY = 20; // qualité WebP volontairement basse — cœur de la promesse éco-data
const MAX_WIDTH = 800; // pas la peine de livrer plus large qu'un écran mobile

/**
 * Récupère une image distante, la compresse en WebP basse qualité,
 * la redimensionne, et met en cache le résultat sur disque.
 * Retourne { buffer, contentType, originalBytes, servedBytes, fromCache }
 */
async function fetchAndCompress(imageUrl, requestedWidth) {
  const width = Math.min(Number(requestedWidth) || MAX_WIDTH, MAX_WIDTH);
  const key = cache.keyFor(imageUrl, width);

  const cached = cache.getCached(key);
  if (cached) {
    return { buffer: cached, contentType: "image/webp", fromCache: true, servedBytes: cached.length };
  }

  const { response: res, tlsRelaxed } = await fetchWithTlsFallback(imageUrl, {
    headers: { "User-Agent": "EcoDataProxy/0.1 (+POC)" },
    timeout: 10000,
  });
  if (!res.ok) {
    throw new Error(`Fetch image échoué (${res.status}) pour ${imageUrl}`);
  }
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.startsWith("image/")) {
    throw new Error(`Pas une image (${contentType}) pour ${imageUrl}`);
  }

  const originalBuffer = await res.buffer();
  const originalBytes = originalBuffer.length;

  const compressed = await sharp(originalBuffer)
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: DEFAULT_QUALITY })
    .toBuffer();

  cache.setCached(key, compressed);
  cache.recordTransform(originalBytes, compressed.length);

  return {
    buffer: compressed,
    contentType: "image/webp",
    fromCache: false,
    originalBytes,
    servedBytes: compressed.length,
    tlsRelaxed,
  };
}

module.exports = { fetchAndCompress };
