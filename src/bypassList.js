// Domaines qu'on ne doit PAS intercepter (tunnel brut, sans déchiffrement) :
// soit parce qu'ils utilisent le certificate pinning (rejettent tout
// certificat autre que le leur, même via une CA de confiance), soit parce
// qu'une protection anti-bot (WAF) détecte l'empreinte TLS d'un client non-
// navigateur et coupe la connexion. Dans les deux cas, la seule option est
// de laisser passer le trafic chiffré tel quel : pas de compression possible
// sur ces domaines précis, mais le site continue de fonctionner.

// Connus à l'avance (services Google avec pinning agressif sur l'attestation
// d'intégrité / la télémétrie de sécurité — pas du contenu de navigation
// normal, donc aucune perte réelle de compression en les excluant).
// const STATIC_BYPASS_PATTERNS = [
//   /(^|\.)clients6\.google\.com$/,
//   /(^|\.)waa-pa\.googleapis\.com$/,
//   /(^|\.)safebrowsing\.google\.com$/,
//   /(^|\.)optimizationguide-pa\.googleapis\.com$/,
// ];

const STATIC_BYPASS_PATTERNS = [];
// Domaines découverts dynamiquement en cours de session (ex: un WAF qui a
// coupé la connexion sortante du proxy) — appris automatiquement, voir
// server.js. Non persisté entre redémarrages pour ce POC (à faire en Phase 1
// si le comportement se confirme sur beaucoup de sites : persister sur
// disque pour ne pas rejouer l'échec à chaque lancement).
const learnedBypassHosts = new Set();

function shouldBypass(hostname) {
  if (!hostname) return false;
  const bare = hostname.split(":")[0]; // enlève un éventuel :port
  if (learnedBypassHosts.has(bare)) return true;
  return STATIC_BYPASS_PATTERNS.some((re) => re.test(bare));
}

function learnBypass(hostname) {
  if (!hostname) return;
  const bare = hostname.split(":")[0];
  if (!learnedBypassHosts.has(bare)) {
    learnedBypassHosts.add(bare);
    console.log(`[bypass] ${bare} ajouté à la liste de contournement (tunnel brut au prochain essai).`);
  }
}

function getLearnedHosts() {
  return Array.from(learnedBypassHosts);
}

module.exports = { shouldBypass, learnBypass, getLearnedHosts };
