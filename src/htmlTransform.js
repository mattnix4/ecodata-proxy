const cheerio = require("cheerio");
const { isTrackerUrl } = require("./trackers");

/**
 * Contrairement à l'ancienne architecture (proxy applicatif par URL), ici on
 * n'a PLUS BESOIN de réécrire aucune URL : le navigateur parle directement
 * au vrai domaine (interception transparente au niveau TLS), donc pas de
 * <base href>, pas de relais /x/, pas de perte de contexte à la navigation,
 * pas de CORS. On se contente de :
 *  - retirer les scripts/iframes trackers connus,
 *  - forcer le lazy-loading sur les images.
 * La compression des images se fait à part, directement sur les réponses
 * de type image/* (voir imageCompress.js), sans toucher au HTML.
 */
function transformHtml(html) {
  const $ = cheerio.load(html);
  let strippedTrackers = 0;

  $("script[src], iframe[src]").each((_, el) => {
    const src = $(el).attr("src");
    if (isTrackerUrl(src)) {
      $(el).remove();
      strippedTrackers += 1;
    }
  });

  $("img").each((index, el) => {
    // La premiere image est souvent l'image principale (LCP). La rendre lazy
    // degraderait le temps d'affichage percu. Respecte aussi le choix du site.
    if (index > 0 && !$(el).attr("loading")) $(el).attr("loading", "lazy");
  });

  return { html: $.html(), strippedTrackers };
}

module.exports = { transformHtml };
