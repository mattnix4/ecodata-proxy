# Proxy Éco-Data — Architecture MITM (system-level)

Nouvelle architecture, en remplacement du proxy par réécriture d'URL
(`ecodata-proxy/`). Élimine structurellement toute la classe de bugs
rencontrée avec l'ancienne approche (CORS, liens qui perdent le contexte,
appels API cross-sous-domaine) en interceptant le trafic **au niveau réseau**
plutôt qu'en réécrivant des URLs.

## Principe

```
Navigateur (proxy configuré : 127.0.0.1:8081)
    │  CONNECT itraav.com:443
    ▼
Proxy MITM (certificat racine local installé sur l'appareil)
    │  déchiffre → strip trackers + compresse les images → re-chiffre
    ▼
Navigateur — ne voit AUCUNE différence d'URL, croit parler en direct au vrai site
```

Le navigateur garde l'URL réelle (`https://itraav.com/...`) tout du long :
pas de `?url=`, pas de `<base href>`, pas de relais `/x/`, pas de perte de
contexte à la navigation. Les appels `fetch()` vers d'autres sous-domaines
(`api.itraav.com`) fonctionnent nativement, sans CORS, puisque le navigateur
leur parle réellement en direct (interception transparente).

## Lancer le POC en local

```bash
npm install
node server.js
# → Proxy MITM sur 127.0.0.1:8081
# → Statistiques sur http://127.0.0.1:8082
# → Certificat racine généré dans .ecodata-mitm-certs/certs/ca.pem
```

## Installer le certificat racine et configurer le proxy

**⚠️ Ce certificat vous donne le pouvoir d'intercepter TOUT le trafic HTTPS de
l'appareil sur lequel il est installé.** À n'utiliser que sur vos propres
appareils de test, jamais distribué publiquement sans avoir sécurisé
correctement la clé privée associée (`.ecodata-mitm-certs/certs/ca.pem` +
la clé privée dans le même dossier).

### Windows
1. Double-cliquer sur `ca.pem` → "Installer le certificat" → "Ordinateur local" → "Placer tous les certificats dans le magasin suivant" → **Autorités de certification racines de confiance**.
2. Réglages Windows → Réseau et Internet → Proxy → Configuration manuelle → Adresse `127.0.0.1`, port `8081`.

### Linux (Ubuntu/Debian)
```bash
sudo cp .ecodata-mitm-certs/certs/ca.pem /usr/local/share/ca-certificates/ecodata-ca.crt
sudo update-ca-certificates
```
Puis configurer le proxy système (Réglages → Réseau → Proxy, ou variables `http_proxy`/`https_proxy=127.0.0.1:8081`).

**Note Firefox** : Firefox a son propre magasin de certificats, indépendant du système. Il faut aussi l'importer dans `about:preferences#privacy` → Certificats → Afficher les certificats → Autorités → Importer.

### Android
1. Transférer `ca.pem` sur l'appareil.
2. Réglages → Sécurité → Chiffrement et identifiants → Installer un certificat → Certificat CA.
3. Réglages → Wi-Fi → (maintenir le réseau) → Modifier → Avancé → Proxy manuel → hôte = IP de la machine qui héberge le proxy, port `8081`.

**Limite connue Android 7+** : depuis Android 7 (Nougat), les apps qui ciblent une API récente **n'utilisent plus par défaut le magasin de certificats utilisateur** (seul le magasin système est utilisé), donc `ca.pem` installé côté utilisateur ne suffit pit pas à intercepter le trafic de toutes les apps automatiquement — seulement Chrome et les apps qui déclarent explicitly y faire confiance. Pour un navigateur natif qu'on développe nous-mêmes (Phase 3), on peut configurer ça nous-mêmes dans l'app ; pour tester avec Chrome standard maintenant, ça fonctionne car Chrome respecte le magasin utilisateur pour le trafic qu'il initie lui-même.

## Notes de correction — tests réels sur Windows

- **`ERR_PROXY_CONNECTION_FAILED` / `Connection refused` sur `127.0.0.1`** :
  causé par la résolution de `localhost` en IPv6 (`::1`) par Node sur
  certaines configs Windows, alors que Chrome/curl contactaient `127.0.0.1`
  (IPv4) — le serveur écoutait sur une adresse différente. Corrigé en forçant
  `host: "127.0.0.1"` explicitement dans `proxy.listen()`.
- **Pinning TLS et blocage WAF** (Google Widevine, Amazon) — voir la section
  dédiée ci-dessous.

## Résultats du test interne

| Test | Résultat |
|---|---|
| HTML (HTTP) : trackers filtrés | 3/3 |
| HTML (HTTP) : lazy-loading appliqué | 4/4 images |
| Image (HTTP) : hero.jpg | 327 878 → 5 138 octets (~64x) |
| **Interception TLS (HTTPS)** : HTML | trackers filtrés, lazy-loading appliqué — identique au test HTTP |
| **Interception TLS (HTTPS)** : image | même compression, aucune erreur |
| `fetch()` interne (`/api/data.json`) | fonctionne nativement, sans Referer, sans relais dédié |
| Navigation par lien vers une autre page du site | fonctionne nativement — le navigateur envoie l'URL réelle, rien à préserver |

**Aucun des bugs de l'ancienne architecture n'a de raison structurelle de se
reproduire ici** (pas de réécriture d'URL = pas de classe de bugs liée à la
réécriture d'URL).

## Automatiser le test sur plusieurs sites (`scripts/test-sites.js`)

Pour le rapport de fin de Phase 0 (30-50 sites réels, jalon M0 de la
roadmap), un script pilote un vrai navigateur headless (Puppeteer) à travers
le proxy — pas un simple `curl`, pour reproduire fidèlement ce que verrait
un utilisateur (JS exécuté, erreurs de rendu détectées).

### Installation et lancement

```bash
npm install   # télécharge aussi Chromium via Puppeteer (peut prendre un moment)

# Terminal 1
node server.js

# Terminal 2
node scripts/test-sites.js
```

### Configurer la liste de sites

Éditez `scripts/sites.json` — format `[{"name": "...", "url": "https://..."}]`.
Le fichier livré ne contient que 2 entrées de démonstration (`itraav.com` et
`google.com`) : **remplacez-le par votre vraie liste de 30-50 sites**
(réseaux sociaux mobile, e-commerce, presse locale, webmail — cf. objectif
Phase 0 du plan initial).

### Ce que le script mesure, par site

- Codes HTTP, temps de chargement, nombre d'erreurs JS console (signal de
  page cassée).
- Ratio de compression et Ko économisés (croisés avec `/stats.byHost`).
- Génère `rapport-phase0.md` (tableau lisible), `rapport-phase0.csv` (pour
  tableur), et `rapport-phase0-stats-brutes.json` (données complètes).

### Limites

- **Ventilation par site imprécise pour les sites multi-domaines** : si un
  site charge ses images depuis un CDN sur un sous-domaine séparé, ce
  sous-domaine a sa propre entrée dans `/stats.byHost` mais n'est pas
  additionné au site principal dans le tableau — le ratio global (toutes
  requêtes confondues, en haut du rapport) reste, lui, exact.
- **`--ignore-certificate-errors`** est utilisé pour Puppeteer plutôt que
  d'installer la CA dans le profil Chromium headless — pratique pour ce test
  automatisé, mais à ne surtout pas faire dans un vrai navigateur de
  production (ça désactive TOUTE vérification de certificat, pas seulement
  la nôtre).
- **Pas testé de bout en bout dans cet environnement** : Puppeteer n'a pas
  pu télécharger Chromium ici (même liste blanche réseau restreinte que
  précédemment) — seule la logique de génération de rapport a été vérifiée
  unitairement (avec des données simulées). À valider chez vous en conditions
  réelles.

## Nettoyage des logs — bruit inoffensif filtré

En usage réel (navigation normale sur Google/itraav.com), le terminal était
noyé sous deux types de bruit sans impact fonctionnel :
- `ON_CONNECT_ERROR: bypass-tunnel-handled` — notre propre signal interne
  (voir `onConnect` plus haut), pas une vraie erreur.
- `Got ECONNRESET on CLIENT_TO_PROXY_SOCKET, ignoring.` — Chrome ferme en
  permanence des connexions spéculatives, bruit de fond normal de tout proxy.
- `[img-compress] échec ... Input Buffer is empty` — très fréquent sur les
  pixels de tracking publicitaire (`gen_204`, `ping`) qui répondent avec un
  `Content-Type: image/*` mais un corps vide : rien à compresser, ce n'est
  pas un échec.

Ces trois cas sont maintenant silencieux (le premier via un filtre ciblé sur
`console.error`, puisque la librairie les logue directement sans passer par
nos hooks ; le second en détectant les corps vides avant de tenter une
compression). Les vraies erreurs continuent de s'afficher normalement.

## Décompression du corps de réponse (`src/decompress.js`) — bug critique corrigé

Découvert en test réel : la quasi-totalité du web moderne sert son HTML/JS/CSS
compressé en transport (`Content-Encoding: gzip` ou `br`). Sans décompression
préalable, le code recevait des **octets encore compressés** au moment de les
parser comme texte (HTML) ou d'en extraire une image — pages cassées ou
vides sur pratiquement tout site réel, y compris `google.com` et très
probablement `itraav.com`.

**Correctif** : `Content-Encoding` est retiré des en-têtes dès `onResponse`
(avant l'envoi des headers — trop tard sinon, cf. la leçon du `<base href>`
plus haut), le corps est décompressé selon l'encodage d'origine
(`zlib.brotliDecompressSync`/`gunzipSync`/`inflateSync`) avant tout
traitement, et servi en clair. Vérifié en local avec une page gzippée
simulée : contenu lisible, tracker retiré, plus de `Content-Encoding` dans
la réponse.

**Coût assumé** : le texte (HTML/JS/CSS) part maintenant non recompressé —
plus volumineux qu'avant pour ce type de contenu. Ré-encoder en gzip après
transformation (`zlib.gzipSync`, quasi-universellement supporté) est la
suite logique en Phase 1 pour ne pas perdre ce gain, une fois la correction
prioritaire (ne pas casser les pages) validée.

**Renforcement suite à un test réel** : sur un site derrière Cloudflare avec
`connection: close`, le flux Brotli s'est retrouvé tronqué en cours de
réponse (connexion coupée avant la fin — cause probable : même famille de
comportement que le blocage WAF observé sur Amazon). La décompression
stricte (`brotliDecompressSync`) plantait sur un flux incomplet, et
l'ancien code de fallback servait alors les octets encore compressés tels
quels — d'où du charabia binaire côté navigateur. Corrigé :
- gzip/deflate tolèrent maintenant un flux tronqué (`Z_SYNC_FLUSH`) et
  renvoient le contenu décodable au lieu de lever une exception ;
- Brotli, qui n'a pas d'équivalent sync tolérant, retombe sur l'API
  streaming en cas d'échec strict, pour récupérer le maximum de contenu
  décodé avant la coupure.

Vérifié avec des flux Brotli/gzip tronqués artificiellement (60-70 %) :
contenu partiel lisible bien récupéré plutôt qu'une perte totale.

**Renforcement suite à un 2e test réel** : sur `mon-ip.com`, la page arrivait
en charabia binaire **sans qu'aucun avertissement `[decompress]` ne
s'affiche** — signe que le code n'essayait même pas de décompresser.
Cause : le `Content-Encoding` était retiré des en-têtes **sans vérifier au
préalable qu'on savait vraiment décompresser ce format** — probablement
`zstd` (Zstandard), de plus en plus utilisé par Cloudflare et non supporté
nativement par le module `zlib` de Node. Le header disparaissait, mais le
corps restait compressé : navigateur induit en erreur.

**Corrigé** : `src/decompress.js` expose désormais `isSupportedEncoding()` ;
si l'encodage annoncé n'est pas dans la liste supportée (gzip/deflate/br),
le proxy **ne touche à rien** — ni `Content-Encoding`, ni `Content-Type` —
et relaie le corps brut tel quel. Le navigateur, qui sait décompresser zstd
nativement, s'en sort très bien tout seul ; c'est nous qui ne pouvons pas
lire ce contenu pour le transformer. **Coût assumé** : pas de strip
trackers/lazy-load/compression d'image sur ces réponses précises — la page
fonctionne, on perd juste l'optimisation dessus. Comptabilisé séparément
dans `/stats.unsupportedEncodings` (utile pour le rapport Phase 0 : mesurer
la fréquence réelle de `zstd`/autres formats sur les 30-50 sites testés).

Vérifié en local avec une page simulant un `Content-Encoding: zstd` :
en-tête et corps intacts, aucune tentative de lecture/transformation.

## Liste de contournement (`src/bypassList.js`) — pinning TLS et anti-bot

Découvert en test réel sur Windows : certains domaines cassent avec
l'interception MITM, pour deux raisons différentes :

1. **Certificate pinning** (ex: endpoints Google Widevine/Safe Browsing) — le
   client rejette explicitement tout certificat qui n'est pas exactement le
   sien, même signé par une CA de confiance. Erreur observée :
   `SSL alert number 46` / `certificate unknown`.
2. **Anti-bot (WAF)** (observé sur `amazon.com`, juste après un domaine
   `awswaf.com`) — le serveur détecte que l'empreinte TLS de la connexion
   *proxy → origine* ne correspond pas à un vrai navigateur, et coupe la
   connexion (`ECONNRESET`) avant la fin du handshake.

**Solution** : pour ces domaines, le proxy bascule en **tunnel brut** (comme
un proxy HTTP CONNECT classique, sans déchiffrement) — le trafic passe
directement entre le navigateur et le vrai serveur, avec la vraie empreinte
TLS du navigateur. Ni le pinning ni la détection anti-bot ne peuvent alors
distinguer ça d'une navigation normale. Coût assumé : pas de compression
possible sur ces domaines précis.

Deux mécanismes combinés :
- **Liste statique** pré-remplie pour les cas connus à l'avance (endpoints Google d'attestation/sécurité).
- **Apprentissage automatique** : quand notre connexion sortante échoue avec un `ECONNRESET` pendant le handshake TLS (signature typique d'un blocage WAF), le domaine concerné (fourni par Node dans `err.host`) est ajouté à la liste pour la suite de la session — un rechargement de page devrait alors passer en tunnel et fonctionner.

Vérifié en local : un domaine ajouté à la liste ne déclenche plus de
génération de certificat, et le contenu relayé est bien l'original brut
(non recompressé) — confirmé sur une image JPEG (327 878 octets, taille et
`Content-Type` inchangés, contre un `image/webp` compressé pour tout domaine
non contourné).

**Limite assumée** : la liste apprise n'est pas persistée entre redémarrages
(à faire si le phénomène se confirme fréquent sur les 30-50 sites réels de
fin de Phase 0). Sur le premier chargement d'un site protégé par WAF, une
page peut donc échouer une fois avant qu'un rechargement fonctionne.
Consultez `bypassedHosts` dans `/stats` pour voir ce qui a été appris.

## ⚠️ Limites de ce POC

- **Bufferisation complète des réponses** avant transformation (pas de streaming chunk par chunk). Simple pour un POC, mais pour de très grosses réponses (vidéos, gros téléchargements), ça consomme de la mémoire proportionnellement à la taille — à revisiter en Phase 1 (streaming avec un buffer de detection du content-type sur les premiers octets seulement).
- **Vérification TLS de la connexion sortante (proxy → site d'origine) relâchée globalement** (`rejectUnauthorized: false`), plutôt que le retry ciblé développé dans le POC précédent (`ecodata-proxy/src/httpAgent.js`). Porter cette même logique ici (strict par défaut, retry uniquement sur erreur de chaîne, avec traçabilité) est la suite logique de ce POC.
- **Pas de gestion HTTP/2** testée — `http-mitm-proxy` gère HTTP/1.1 ; beaucoup de sites modernes servent en HTTP/2, à vérifier avec de vrais sites.
- **WebSocket non transformé** (juste relayé, la lib le supporte nativement mais on ne l'a pas branché à notre logique).
- **Android 7+** : voir la limite du magasin de certificats ci-dessus — pertinent pour la conception de l'app native en Phase 3, pas bloquant pour valider le proxy avec Chrome aujourd'hui.
- **Pas testé sur un vrai site externe** depuis cet environnement (réseau du sandbox de développement restreint à une liste blanche de domaines qui n'inclut pas de sites publics arbitraires) — validé uniquement sur un site de démo local (HTTP et HTTPS auto-signé). **À tester sur votre machine avec un vrai site.**

## Prochaine étape

1. Tester ce proxy avec Chrome/Firefox standard sur votre machine, contre `itraav.com` — ça devrait résoudre tous les bugs rencontrés avec l'ancienne architecture, sans code supplémentaire.
2. Si validé : mesurer le ratio de compression réel sur 30-50 sites (objectif initial de Phase 0, jamais atteint avec l'ancienne architecture à cause des blocages).
3. Ensuite seulement : envisager l'app native légère (Electron/WebView) qui embarque ce proxy en local plutôt qu'un vrai fork Chromium.

## Structure du projet

```
ecodata-mitm/
├── server.js                    # proxy MITM (http-mitm-proxy) + hooks de transformation
├── src/
│   ├── htmlTransform.js         # strip trackers + lazy-loading (plus de réécriture d'URL)
│   ├── imageCompress.js         # compression WebP q=20 en mémoire
│   ├── trackers.js              # liste de domaines trackers (réutilisée du POC précédent)
│   └── stats.js                 # statistiques cumulées
├── demo/                        # site de démo (HTTP + HTTPS auto-signé) pour tester en local
└── .ecodata-mitm-certs/         # certificat racine généré (à NE PAS committer/partager publiquement)
```
