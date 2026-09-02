const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CACHE_DIR = path.join(__dirname, "..", "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// Stats globales en mémoire — en prod ce serait dans Redis, partagé entre workers.
const stats = {
  requests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  bytesOriginal: 0,
  bytesServed: 0,
};

// Domaines dont la chaîne de certificat était incomplète (mode TLS relâché utilisé).
// Donnée utile pour le rapport Phase 0 : fréquence des sites mal configurés sur le marché cible.
const tlsRelaxedDomains = new Set();

function recordTlsRelaxed(url) {
  try {
    tlsRelaxedDomains.add(new URL(url).hostname);
  } catch {
    // URL invalide, on ignore silencieusement — pas critique pour la stat.
  }
}

function keyFor(url, width) {
  return crypto.createHash("sha256").update(`${url}::w${width || "auto"}`).digest("hex");
}

function cachePathFor(key) {
  return path.join(CACHE_DIR, `${key}.webp`);
}

function getCached(key) {
  const p = cachePathFor(key);
  if (fs.existsSync(p)) {
    stats.cacheHits += 1;
    return fs.readFileSync(p);
  }
  stats.cacheMisses += 1;
  return null;
}

function setCached(key, buffer) {
  fs.writeFileSync(cachePathFor(key), buffer);
}

function recordTransform(originalBytes, servedBytes) {
  stats.requests += 1;
  stats.bytesOriginal += originalBytes;
  stats.bytesServed += servedBytes;
}

function getStats() {
  const saved = stats.bytesOriginal - stats.bytesServed;
  const ratio = stats.bytesOriginal > 0 ? stats.bytesOriginal / Math.max(stats.bytesServed, 1) : 0;
  const hitRate = stats.requests > 0 ? stats.cacheHits / (stats.cacheHits + stats.cacheMisses) : 0;
  return {
    ...stats,
    bytesSaved: saved,
    compressionRatio: Number(ratio.toFixed(2)),
    cacheHitRate: Number((hitRate * 100).toFixed(1)),
    tlsRelaxedDomains: Array.from(tlsRelaxedDomains),
  };
}

module.exports = { keyFor, getCached, setCached, recordTransform, getStats, recordTlsRelaxed };
