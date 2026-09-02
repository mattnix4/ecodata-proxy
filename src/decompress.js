const zlib = require("zlib");

// Encodages qu'on sait décompresser. Node ne supporte pas nativement zstd
// (Zstandard), de plus en plus utilisé par Cloudflare et d'autres CDN — un
// site qui l'utilise ne doit PAS voir son Content-Encoding retiré si on ne
// peut pas décompresser derrière, sous peine de servir des octets encore
// compressés avec un en-tête qui prétend le contraire (page cassée/vide).
const SUPPORTED_ENCODINGS = ["gzip", "x-gzip", "deflate", "br"];
const MAX_DECOMPRESSED_BYTES = Number(process.env.MAX_TRANSFORM_BYTES) || 15 * 1024 * 1024;

function isSupportedEncoding(contentEncoding) {
  if (!contentEncoding) return true; // pas d'encodage = rien à décompresser, "supporté" par définition
  return SUPPORTED_ENCODINGS.includes(contentEncoding.toLowerCase().trim());
}

/**
 * Décompresse un corps de réponse HTTP selon son Content-Encoding d'origine.
 * Indispensable : sans ça, tout site utilisant Brotli ou gzip (la quasi-
 * totalité du web moderne — Next.js, Cloudflare, Google...) renvoie des
 * octets encore compressés au moment où on essaie de les parser comme du
 * texte (HTML) ou d'analyser une image, ce qui casse silencieusement la
 * page ou produit un rendu vide/corrompu.
 *
 * Tolère les flux tronqués (connexion coupée en cours de réponse — observé
 * en test réel derrière un WAF/CDN) : plutôt que de lever une exception sur
 * un flux incomplet, on récupère le maximum de contenu décompressable et on
 * le retourne, avec `truncated: true` pour que l'appelant puisse le
 * signaler. Un flux Brotli/gzip tronqué est de toute façon déjà cassé côté
 * serveur d'origine — mieux vaut servir un HTML partiel que rien du tout.
 *
 * Async (retourne une Promise) car la récupération partielle Brotli
 * nécessite l'API streaming — pas d'équivalent synchrone fiable dans Node.
 */
async function decompressBody(buffer, contentEncoding) {
  const enc = (contentEncoding || "").toLowerCase().trim();
  try {
    if (enc === "gzip" || enc === "x-gzip") {
      // Z_SYNC_FLUSH tolère un flux gzip incomplet au lieu de lever une
      // exception "unexpected end of file" — on récupère ce qui est décodable.
      return { buffer: zlib.gunzipSync(buffer, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: MAX_DECOMPRESSED_BYTES }), truncated: false };
    }
    if (enc === "deflate") {
      return { buffer: zlib.inflateSync(buffer, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: MAX_DECOMPRESSED_BYTES }), truncated: false };
    }
    if (enc === "br") {
      try {
        return { buffer: zlib.brotliDecompressSync(buffer, { maxOutputLength: MAX_DECOMPRESSED_BYTES }), truncated: false };
      } catch (err) {
        if (err && err.code === "ERR_BUFFER_TOO_LARGE") {
          console.warn("[decompress] sortie Brotli trop volumineuse, transformation abandonnee.");
          return { buffer: Buffer.alloc(0), truncated: true };
        }
        // Flux Brotli tronqué : l'API sync n'a pas d'équivalent Z_SYNC_FLUSH,
        // on retombe sur l'API streaming qui renvoie ce qu'elle a pu décoder
        // avant l'erreur plutôt que de tout perdre.
        return await decompressBrotliPartial(buffer);
      }
    }
    return { buffer, truncated: false }; // pas d'encodage de transport, ou "identity"
  } catch (err) {
    console.warn(`[decompress] échec (${enc || "identity"}): ${err.message} — corps compressé non transmis avec un en-tête incohérent.`);
    return { buffer: Buffer.alloc(0), truncated: true };
  }
}

function decompressBrotliPartial(buffer) {
  return new Promise((resolve) => {
    const chunks = [];
    const decoder = zlib.createBrotliDecompress();

    decoder.on("data", (c) => chunks.push(c));
    decoder.on("error", () => {
      const partial = Buffer.concat(chunks);
      if (partial.length > 0) {
        console.warn(`[decompress] Brotli tronqué : ${partial.length} octets récupérés en partiel.`);
      } else {
        console.warn("[decompress] Brotli tronqué : aucun contenu récupérable.");
      }
      resolve({ buffer: partial, truncated: true });
    });
    decoder.on("end", () => {
      resolve({ buffer: Buffer.concat(chunks), truncated: false });
    });

    decoder.end(buffer);
  });
}

module.exports = { decompressBody, isSupportedEncoding };
