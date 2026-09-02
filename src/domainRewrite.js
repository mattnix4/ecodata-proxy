/**
 * Donne le "domaine enregistrable" d'un hostname (ex: api.itraav.com -> itraav.com).
 * Heuristique simple (2 derniers labels) — insuffisante pour les TLD composés
 * (ex: .co.uk), acceptable pour un POC mais à remplacer par une vraie liste
 * publique de suffixes (psl / `tldts`) avant la production.
 */
function registrableDomainOf(hostname) {
  const parts = hostname.split(".");
  if (parts.length <= 2) return hostname;
  return parts.slice(-2).join(".");
}

/**
 * Réécrit, dans un texte JS/CSS/JSON, toute URL absolue pointant vers le même
 * domaine enregistrable (y compris les sous-domaines, ex: api.itraav.com,
 * cdn.itraav.com) pour qu'elle passe par notre relais /x/<host>/... au lieu
 * de partir en direct depuis le navigateur (ce qui déclenche le blocage CORS
 * observé sur api.itraav.com).
 *
 * Ne touche pas aux URLs vers d'autres domaines (CDN tiers, Google Fonts...)
 * — celles-ci restent en direct, ce qui est généralement sans CORS pour de
 * simples fetch en mode 'no-cors' implicite ou fonctionne déjà côté serveur tiers.
 */
function rewriteAbsoluteDomainRefs(text, { registrableDomain, proxyOrigin }) {
  if (!registrableDomain || !text) return text;
  const escaped = registrableDomain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`https?:\\/\\/([a-zA-Z0-9-]+\\.)*${escaped}`, "g");
  return text.replace(re, (match) => {
    const host = match.replace(/^https?:\/\//, "");
    return `${proxyOrigin}/x/${host}`;
  });
}

module.exports = { registrableDomainOf, rewriteAbsoluteDomainRefs };
