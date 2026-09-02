// Liste non-exhaustive de domaines de tracking / analytics / pub à retirer du HTML.
// Objectif POC : montrer le mécanisme de filtrage, pas fournir une liste exhaustive
// (en prod on utiliserait une liste maintenue type EasyList / EasyPrivacy).
const TRACKER_PATTERNS = [
  /google-analytics\.com/i,
  /googletagmanager\.com/i,
  /googletagservices\.com/i,
  /googlesyndication\.com/i,
  /doubleclick\.net/i,
  /facebook\.net\/.*\/fbevents/i,
  /connect\.facebook\.net/i,
  /hotjar\.com/i,
  /mixpanel\.com/i,
  /segment\.(io|com)/i,
  /amplitude\.com/i,
  /criteo\.(com|net)/i,
  /taboola\.com/i,
  /outbrain\.com/i,
  /scorecardresearch\.com/i,
  /adsystem\.(com|net)/i,
  /adnxs\.com/i,
  /pubmatic\.com/i,
  /rubiconproject\.com/i,
];

function isTrackerUrl(url) {
  if (!url) return false;
  return TRACKER_PATTERNS.some((re) => re.test(url));
}

module.exports = { isTrackerUrl, TRACKER_PATTERNS };
