const https = require("https");
const fetch = require("node-fetch");

// Agent strict (comportement par défaut Node) — vérifie la chaîne de certificats normalement.
const strictAgent = new https.Agent({ rejectUnauthorized: true });

// Agent de secours — n'est utilisé qu'après un échec de vérification de certificat,
// jamais par défaut. Sert uniquement à ne pas casser l'expérience utilisateur face
// à des sites mal configurés (chaîne intermédiaire manquante, très courant sur
// certains hébergeurs low-cost) — PAS pour couvrir de vrais sites malveillants.
const relaxedAgent = new https.Agent({ rejectUnauthorized: false });

const CERT_ERROR_PATTERNS = [
  "unable to verify the first certificate",
  "unable to get local issuer certificate",
  "certificate has expired",
  "self signed certificate",
  "self-signed certificate",
  "unable to get issuer certificate",
];

function isCertError(err) {
  const msg = (err && err.message ? err.message : String(err)).toLowerCase();
  return CERT_ERROR_PATTERNS.some((p) => msg.includes(p));
}

/**
 * Fetch avec vérification TLS stricte par défaut. En cas d'erreur de certificat
 * (chaîne incomplète, très fréquent sur des hébergeurs mal configurés), retente
 * une fois en mode relâché et marque le résultat pour traçabilité/monitoring.
 *
 * Retourne { response, tlsRelaxed: boolean } au lieu d'une simple Response,
 * pour que l'appelant puisse logger/exposer l'info sans deviner.
 */
async function fetchWithTlsFallback(url, options = {}) {
  if (url.startsWith("https://")) {
    try {
      const response = await fetch(url, { ...options, agent: strictAgent });
      return { response, tlsRelaxed: false };
    } catch (err) {
      if (!isCertError(err)) throw err;
      console.warn(`[TLS] Chaîne de certificat invalide pour ${url} — retry en mode relâché. (${err.message})`);
      const response = await fetch(url, { ...options, agent: relaxedAgent });
      return { response, tlsRelaxed: true };
    }
  }
  // HTTP simple : pas de TLS, rien à négocier.
  const response = await fetch(url, options);
  return { response, tlsRelaxed: false };
}

module.exports = { fetchWithTlsFallback, isCertError };
