const Proxy = require("http-mitm-proxy").Proxy;
const https = require("https");
const http = require("http");
const net = require("net");
const tls = require("tls");
const fs = require("fs");
const path = require("path");

const { transformHtml } = require("./src/htmlTransform");
const { isCompressibleImage, compressImage } = require("./src/imageCompress");
const { decompressBody, isSupportedEncoding } = require("./src/decompress");
const stats = require("./src/stats");
const { shouldBypass, learnBypass, getLearnedHosts } = require("./src/bypassList");
const { isCertificateError } = require("./src/certErrors");
const upstreams = require("./src/upstreamManager");
const clients = require("./src/clientManager");

const PORT = process.env.MITM_PORT || 8081;
const STATS_PORT = process.env.STATS_PORT || 8082;
const PROXY_HOST = process.env.PROXY_HOST || "0.0.0.0";
const DASHBOARD_HOST = process.env.DASHBOARD_HOST || "0.0.0.0";
const DASHBOARD_DIR = path.join(__dirname, "dashboard");
const ROOT_CA_PATH = path.join(process.cwd(), ".ecodata-mitm-certs", "certs", "ca.pem");

function truncateUrl(url, max = 100) {
  if (!url || url.length <= max) return url;
  return `${url.slice(0, max)}… (${url.length} car.)`;
}

// La librairie http-mitm-proxy logue certains événements DIRECTEMENT en
// console.error/console.debug, sans passer par nos hooks — impossible à
// filtrer autrement. Ce sont des événements bénins et attendus dans notre
// architecture (cf. README) : "bypass-tunnel-handled" est notre propre
// signal interne (pas une vraie erreur), et les ECONNRESET sur le socket
// client sont un bruit de fond normal de Chrome (connexions spéculatives
// fermées). On les filtre pour garder des logs lisibles, sans toucher aux
// vraies erreurs.
const NOISE_PATTERNS = [/bypass-tunnel-handled/, /proxy-auth-required/, /ON_CONNECT_ERROR/, /CLIENT_TO_PROXY_SOCKET/, /^PROXY_TO_SERVER_REQUEST_ERROR/, /^Socket error:$/, /^Error: read ECONNRESET$/, /onStreamRead/];
function filterConsole(method) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    const text = args.map((a) => (a && a.stack ? a.stack : String(a))).join(" ");
    if (NOISE_PATTERNS.some((re) => re.test(text))) return;
    original(...args);
  };
}
filterConsole("error");
filterConsole("debug");
filterConsole("log");

const proxy = new Proxy();

// Agent HTTPS pour les connexions PROXY -> SITE D'ORIGINE (pas client -> proxy,
// qui elle est interceptée via le certificat racine généré par la lib).
// rejectUnauthorized:false ici est une relaxation ASSUMÉE, pas un oubli : le
// marché cible (hébergeurs low-cost à Madagascar) a un taux élevé de chaînes
// de certificats incomplètes (cf. le POC précédent, src/httpAgent.js, qui
// gérait ça par retry ciblé plutôt que par désactivation globale). Porter la
// même logique de retry ici est identifié comme suite de Phase 0 — cf. README.
// Combine le bundle Node et le magasin Windows sans desactiver TLS strict.
const systemCaCertificates = typeof tls.getCACertificates === "function"
  ? tls.getCACertificates("system")
  : [];
const trustedCaCertificates = Array.from(new Set([
  ...tls.rootCertificates,
  ...systemCaCertificates,
]));
const strictHttpsAgent = new https.Agent({
  rejectUnauthorized: true,
  ca: trustedCaCertificates,
});
const MAX_TRANSFORM_BYTES = Number(process.env.MAX_TRANSFORM_BYTES) || 15 * 1024 * 1024;
const tlsValidatedHosts = new Set();

proxy.onError((ctx, err, errorKind) => {
  // "bypass-tunnel-handled" est notre propre signal interne (voir onConnect
  // plus bas) pour dire à la librairie de ne pas continuer son traitement
  // MITM normal — pas une vraie erreur, on l'ignore ici pour ne pas polluer
  // les logs (la librairie elle-même logue encore une ligne de son côté,
  // cosmétique, sans impact fonctionnel).
  if (err && (err.message === "bypass-tunnel-handled" || err.message === "proxy-auth-required")) return;

  // Erreurs fréquentes et sans gravité (fermetures de connexion, timeouts client) —
  // on les logue en une ligne plutôt que de spammer la stack trace complète.
  const host = ctx && ctx.clientToProxyRequest ? ctx.clientToProxyRequest.headers.host : (err && err.host) || "?";
  console.warn(`[proxy-error] ${errorKind} sur ${host}: ${err.message}`);
  if (errorKind === "PROXY_TO_SERVER_REQUEST_ERROR" && ctx && ctx.ecoUpstreamId) {
    upstreams.recordFailure(ctx.ecoUpstreamId);
  }

  // Apprentissage automatique : si notre connexion sortante vers l'origine
  // échoue de façon caractéristique d'un blocage anti-bot (reset pendant la
  // négociation TLS), on bascule ce domaine en tunnel brut pour la suite —
  // voir src/bypassList.js. err.host est fourni par Node pour ce type
  // d'erreur (ECONNRESET / ECONNREFUSED sur https.request).
  if (errorKind === "PROXY_TO_SERVER_REQUEST_ERROR" && err && !(ctx && ctx.ecoUpstreamId)) {
    const upstreamHost = (err.host || host || "").split(":")[0];
    if (err.code === "ECONNRESET" || isCertificateError(err)) {
      learnBypass(upstreamHost);
      if (isCertificateError(err)) {
        console.warn(`[TLS] ${upstreamHost} ajoute au tunnel direct pour les prochaines connexions.`);
      }
    }
  }
});

proxy.onRequestHeaders((ctx, callback) => {
  try {
    upstreams.applyToRequest(ctx, trustedCaCertificates);
    callback();
  } catch (err) {
    callback(err);
  }
});

/**
 * Tunnel brut (sans interception TLS) pour les domaines de la liste de
 * contournement — voir src/bypassList.js. Le proxy se contente ici de
 * relayer les octets bruts entre le client et le vrai serveur, exactement
 * comme un proxy HTTP CONNECT classique (non-MITM) : pas de génération de
 * certificat, pas de déchiffrement, donc ni pinning ni empreinte TLS
 * suspecte pour ces domaines précis.
 */
function connectRawTunnel(req, socket, head, callback) {
  const [targetHost, targetPortStr] = (req.url || "").split(":");
  const targetPort = parseInt(targetPortStr, 10) || 443;
  upstreams.openTunnel(targetHost, targetPort, trustedCaCertificates, (tunnelError, upstream, upstreamHead) => {
    if (tunnelError) {
      console.warn(`[bypass-tunnel] erreur vers ${targetHost}: ${tunnelError.message}`);
      socket.destroy();
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (upstreamHead && upstreamHead.length) socket.write(upstreamHead);
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
    upstream.on("error", (err) => {
      console.warn(`[bypass-tunnel] erreur vers ${targetHost}: ${err.message}`);
      socket.destroy();
    });
    socket.on("error", () => upstream.destroy());
  });

  // On a pris en charge la connexion nous-même : on signale une "erreur"
  // pour empêcher la librairie de continuer son propre traitement MITM sur
  // ce même socket (cf. lib/proxy.js — sans ctx, _onError se contente de
  // logguer, il ne touche pas au socket qu'on a déjà détourné).
  return callback(new Error("bypass-tunnel-handled"));
}

proxy.onConnect((req, socket, head, callback) => {
  const client = clients.authenticateProxy(req.headers["proxy-authorization"]);
  if (!client) {
    socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"EcoData\"\r\nConnection: close\r\n\r\n");
    return callback(new Error("proxy-auth-required"));
  }
  req.ecoClientId = client.id;
  const [host, portText] = (req.url || "").split(":");
  const port = parseInt(portText, 10) || 443;

  if (shouldBypass(host)) return connectRawTunnel(req, socket, head, callback);
  if (!upstreams.isDirectMode()) return callback();
  if (tlsValidatedHosts.has(host)) return callback();

  let settled = false;
  const probe = tls.connect({
    host,
    port,
    servername: net.isIP(host) ? undefined : host,
    rejectUnauthorized: true,
    ca: trustedCaCertificates,
    timeout: 4000,
  });
  probe.once("secureConnect", () => {
    if (settled) return;
    settled = true;
    tlsValidatedHosts.add(host);
    probe.destroy();
    callback();
  });
  probe.once("error", (err) => {
    if (settled) return;
    settled = true;
    probe.destroy();
    if (isCertificateError(err)) {
      learnBypass(host);
      return connectRawTunnel(req, socket, head, callback);
    }
    callback();
  });
  probe.once("timeout", () => probe.destroy(new Error("TLS preflight timeout")));
});

proxy.onRequest((ctx, callback) => {
  const authHeader = ctx.connectRequest
    ? ctx.connectRequest.headers["proxy-authorization"]
    : ctx.clientToProxyRequest.headers["proxy-authorization"];
  const client = clients.authenticateProxy(authHeader);
  if (!client) {
    ctx.proxyToClientResponse.writeHead(407, { "Proxy-Authenticate": "Basic realm=\"EcoData\"", "Connection": "close" });
    ctx.proxyToClientResponse.end("Proxy authentication required");
    return callback(new Error("proxy-auth-required"));
  }
  ctx.ecoClientId = client.id;
  callback();
});

proxy.onRequest((ctx, callback) => {
  // http-mitm-proxy may continue invoking later onRequest handlers after the
  // authentication handler returned an error. The 407 has already been sent;
  // do not account for or transform that unauthenticated request.
  if (!ctx.ecoClientId) return callback();
  const host = ctx.clientToProxyRequest.headers.host;
  stats.recordRequest(host, ctx.ecoClientId);

  let willCompressImage = false;
  let willTransformHtml = false;
  let shouldBuffer = false;
  let bufferOverflow = false;
  let bufferedBytes = 0;
  let originalEncoding = "";
  let encodingUnsupported = false;

  // Ce hook s'exécute AVANT l'envoi des en-têtes au client (writeHead) — c'est
  // le seul moment où on peut changer Content-Type/Content-Encoding.
  ctx.onResponse((ctx, callback) => {
    const headers = ctx.serverToProxyResponse.headers;
    const contentType = headers["content-type"] || "";
    const contentEncoding = headers["content-encoding"];

    const hasBody = ctx.clientToProxyRequest.method !== "HEAD" &&
      ![204, 205, 304].includes(ctx.serverToProxyResponse.statusCode);
    willCompressImage = hasBody && isCompressibleImage(contentType);
    willTransformHtml = hasBody && contentType.toLowerCase().includes("text/html");
    shouldBuffer = willCompressImage || willTransformHtml;
    const declaredLength = Number(headers["content-length"]);
    if (!Number.isFinite(declaredLength) || declaredLength > MAX_TRANSFORM_BYTES) {
      shouldBuffer = false;
      willCompressImage = false;
      willTransformHtml = false;
    }
    if (!shouldBuffer) return callback();

    if (!isSupportedEncoding(contentEncoding)) {
      // Encodage qu'on ne sait pas décompresser (ex: zstd) : on NE TOUCHE À
      // RIEN — ni Content-Encoding, ni Content-Type — et on relaiera les
      // octets bruts tels quels dans onResponseEnd. Le navigateur, lui, sait
      // décompresser zstd nativement ; c'est uniquement NOUS qui ne pouvons
      // pas lire ce contenu pour le transformer. Coût assumé : pas de strip
      // trackers/lazy-load/compression d'image sur ces réponses précises,
      // mais la page continue de fonctionner (priorité absolue).
      encodingUnsupported = true;
      originalEncoding = contentEncoding || "";
      return callback();
    }

    ctx.responseContentPotentiallyModified = true;
    delete headers.etag;
    delete headers["content-md5"];
    delete headers["accept-ranges"];

    // On va systématiquement décompresser le corps (gzip/br/deflate) pour
    // pouvoir le lire/modifier, puis le servir en clair ("identity") : il
    // faut donc retirer Content-Encoding MAINTENANT, avant que les headers
    // ne partent — sinon le navigateur s'attend à des octets encore
    // compressés et casse le rendu (c'est exactement le bug rencontré sur
    // les pages Brotli). Coût assumé : un peu plus de données pour le
    // texte/JS/CSS non réencodé ensuite — acceptable au stade POC, cf.
    // README pour la piste de ré-encodage gzip en Phase 1.
    if (contentEncoding) {
      originalEncoding = contentEncoding;
      delete headers["content-encoding"];
    }

    return callback();
  });

  // On bufferise entièrement la réponse (pas de streaming chunk-par-chunk) car
  // la compression d'image et le parsing HTML ont besoin du corps complet.
  // Trade-off assumé pour ce POC : latence ajoutée par page proportionnelle à
  // sa taille, acceptable pour valider le mécanisme, à revisiter en Phase 1
  // si des pages très volumineuses posent un problème de mémoire/latence.
  const chunks = [];
  ctx.onResponseData((ctx, chunk, callback) => {
    if (!shouldBuffer || encodingUnsupported) return callback(null, chunk);
    bufferedBytes += chunk.length;
    if (bufferedBytes > MAX_TRANSFORM_BYTES) bufferOverflow = true;
    chunks.push(chunk);
    return callback(null); // on ne renvoie rien ici, tout part dans onResponseEnd
  });

  ctx.onResponseEnd(async (ctx, callback) => {
    try {
      if (!shouldBuffer) return callback();

      if (encodingUnsupported) {
        // On ne peut pas lire ce corps (encodage inconnu) : on le relaie
        // strictement tel quel, headers d'origine inchangés (voir onResponse
        // ci-dessus). Compté à part dans les stats pour le rapport Phase 0.
        stats.recordUnsupportedEncoding(originalEncoding, host, ctx.ecoClientId);
        return callback();
      }

      const rawBody = Buffer.concat(chunks);
      if (bufferOverflow) {
        console.warn(`[transform-skip] corps trop volumineux (${bufferedBytes} octets) sur ${host}`);
        const { buffer: uncompressed } = await decompressBody(rawBody, originalEncoding);
        ctx.proxyToClientResponse.write(uncompressed);
        return callback();
      }

      const { buffer: body, truncated } = await decompressBody(rawBody, originalEncoding);
      if (truncated) {
        console.warn(`[truncated] réponse tronquée servie partiellement pour ${host}${ctx.clientToProxyRequest.url}`);
      }
      const originalBytes = body.length;

      if (willCompressImage) {
        if (originalBytes === 0) {
          // Fréquent sur les pixels de tracking publicitaire (gen_204, ping...)
          // qui répondent avec un Content-Type image/* mais un corps vide.
          // Rien à compresser — on sert tel quel, silencieusement (pas la
          // peine de logguer un "échec" pour un cas parfaitement normal).
          ctx.proxyToClientResponse.write(body);
        } else {
        try {
          const contentType = ctx.serverToProxyResponse.headers["content-type"] || "";
          const { buffer } = await compressImage(body, contentType);
          if (buffer.length < originalBytes) {
            stats.recordImageCompression(originalBytes, buffer.length, host, ctx.ecoClientId);
            ctx.proxyToClientResponse.write(buffer);
          } else {
            ctx.proxyToClientResponse.write(body);
          }
        } catch (err) {
          // Échec de compression (image corrompue, format exotique...) : on
          // sert l'original tel quel plutôt que de casser la page. Le
          // Content-Type annoncé était déjà "image/webp" à ce stade — un
          // léger mismatch assumé pour ce POC (cf. limites du README).
          console.warn(`[img-compress] échec sur ${host}${truncateUrl(ctx.clientToProxyRequest.url)}: ${err.message}`);
          ctx.proxyToClientResponse.write(body);
        }
        }
      } else {
        const contentType = ctx.serverToProxyResponse.headers["content-type"] || "";
        if (contentType.includes("text/html")) {
          const htmlStr = body.toString("utf8");
          const { html, strippedTrackers } = transformHtml(htmlStr);
          if (strippedTrackers > 0) stats.recordTrackersStripped(strippedTrackers, host, ctx.ecoClientId);
          ctx.proxyToClientResponse.write(Buffer.from(html, "utf8"));
        } else {
          // Tout le reste (CSS, JS, fonts, JSON, API...) : relayé tel quel,
          // sans aucune réécriture d'URL — c'est tout l'intérêt de cette
          // architecture par rapport à la précédente.
          ctx.proxyToClientResponse.write(body);
        }
      }
    } catch (err) {
      console.warn(`[onResponseEnd] erreur sur ${host}: ${err.message}`);
      // Fallback : on sert au moins le corps décompressé si on l'a, sinon le
      // brut en dernier recours (mieux qu'une réponse vide, mais peut encore
      // être mal interprété si la décompression elle-même avait échoué).
      const { buffer: fallback } = await decompressBody(Buffer.concat(chunks), originalEncoding);
      ctx.proxyToClientResponse.write(fallback);
    }
    return callback();
  });

  return callback();
});

proxy.listen({ port: PORT, host: PROXY_HOST, sslCaDir: process.cwd() + "/.ecodata-mitm-certs", httpsAgent: strictHttpsAgent }, () => {
  console.log(`Proxy MITM éco-data démarré sur ${PROXY_HOST}:${PORT}`);
  console.log(`Certificat racine à installer : ${process.cwd()}/.ecodata-mitm-certs/certs/ca.pem`);
});

// Petit serveur HTTP séparé pour consulter les statistiques cumulées
// (séparé du proxy pour ne pas interférer avec l'interception TLS).
const DASHBOARD_ASSETS = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/dashboard.css": ["dashboard.css", "text/css; charset=utf-8"],
  "/upstreams.css": ["upstreams.css", "text/css; charset=utf-8"],
  "/dashboard.js": ["dashboard.js", "application/javascript; charset=utf-8"],
  "/favicon.ico": ["favicon.ico", "image/x-icon"],
  "/favicon.png": ["favicon.png", "image/png"],
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(payload, null, 2));
}

const configuredExtensionOrigins = new Set(
  String(process.env.EXTENSION_ORIGINS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean)
);

function allowExtensionCors(req, res) {
  const origin = String(req.headers.origin || "");
  const allowed = configuredExtensionOrigins.size
    ? configuredExtensionOrigins.has(origin)
    : /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
  if (!allowed) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Client-Id, X-EcoData-User, X-EcoData-Password, X-EcoData-Device");
  res.setHeader("Access-Control-Max-Age", "600");
  res.setHeader("Vary", "Origin");
  return true;
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > limit) return reject(new Error("Configuration trop volumineuse"));
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("JSON invalide")); }
    });
    req.on("error", reject);
  });
}

function dashboardClient(req) {
  const clientId = req.headers["x-client-id"];
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return clients.authenticateDashboard(clientId, token);
}

http
  .createServer((req, res) => {
    const requestUrl = new URL(req.url, "http://127.0.0.1");
    const extensionApi = requestUrl.pathname.startsWith("/api/extension/");
    const extensionOriginAllowed = extensionApi && allowExtensionCors(req, res);
    if (extensionApi && req.method === "OPTIONS") {
      if (!extensionOriginAllowed) return sendJson(res, 403, { error: "Origine extension non autorisée" });
      res.writeHead(204);
      return res.end();
    }
    const client = requestUrl.pathname.startsWith("/api/") ? dashboardClient(req) : null;

    if (requestUrl.pathname === "/api/extension/stats" && req.method === "GET") {
      const extensionClient = clients.authenticateProxyCredentials(req.headers["x-ecodata-user"], req.headers["x-ecodata-password"]);
      if (!extensionClient) return sendJson(res, 401, { error: "Identifiants client invalides" });
      const clientStats = stats.getStats(extensionClient.id);
      return sendJson(res, 200, {
        client: { id: extensionClient.id, name: extensionClient.name },
        requests: clientStats.requests,
        imagesCompressed: clientStats.imagesCompressed,
        trackersStripped: clientStats.trackersStripped,
        bytesOriginal: clientStats.bytesOriginal,
        bytesServed: clientStats.bytesServed,
        bytesSaved: Math.max(clientStats.bytesSaved, 0)
      });
    }
    if (requestUrl.pathname === "/api/extension/login" && req.method === "POST") {
      const extensionClient = clients.authenticateProxyCredentials(req.headers["x-ecodata-user"], req.headers["x-ecodata-password"]);
      if (!extensionClient) return sendJson(res, 401, { error: "Utilisateur proxy ou mot de passe incorrect" });
      try {
        const proxySession = clients.issueProxySession(extensionClient, req.headers["x-ecodata-device"]);
        return sendJson(res, 200, { clientId: extensionClient.id, proxySession, client: { id: extensionClient.id, name: extensionClient.name } });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    if (requestUrl.pathname === "/api/extension/logout" && req.method === "POST") {
      const extensionClient = clients.authenticateProxyCredentials(req.headers["x-ecodata-user"], req.headers["x-ecodata-password"]);
      if (!extensionClient) return sendJson(res, 401, { error: "Identifiants client invalides" });
      const revoked = clients.revokeProxySession(req.headers["x-ecodata-device"], extensionClient.id);
      return sendJson(res, 200, { revoked });
    }
    if (requestUrl.pathname === "/ca.pem" && req.method === "GET") {
      return fs.readFile(ROOT_CA_PATH, (err, body) => {
        if (err) return sendJson(res, 404, { error: "Certificat EcoData indisponible" });
        res.writeHead(200, { "Content-Type": "application/x-pem-file", "Content-Disposition": "attachment; filename=ecodata-ca.pem", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        res.end(body);
      });
    }

    if (["/reset", "/api/reset"].includes(requestUrl.pathname) && req.method === "POST") {
      if (!client) return sendJson(res, 401, { error: "Dashboard non autorisé" });
      stats.resetStats(client.id);
      return sendJson(res, 200, { reset: true });
    }
    if (["/stats", "/api/stats"].includes(requestUrl.pathname) && req.method === "GET") {
      if (!client) return sendJson(res, 401, { error: "Dashboard non autorisé" });
      return sendJson(res, 200, { ...stats.getStats(client.id), bypassedHosts: client.admin ? getLearnedHosts() : [], upstreams: client.admin ? upstreams.getStatus() : undefined, client: { id: client.id, name: client.name, admin: !!client.admin } });
    }
    if (requestUrl.pathname === "/api/upstreams" && req.method === "GET") {
      if (!client || !client.admin) return sendJson(res, 403, { error: "Accès administrateur requis" });
      return sendJson(res, 200, upstreams.getConfig());
    }
    if (requestUrl.pathname === "/api/upstreams" && req.method === "PUT") {
      if (!client || !client.admin) return sendJson(res, 403, { error: "Accès administrateur requis" });
      readJson(req)
        .then(body => sendJson(res, 200, upstreams.save(body)))
        .catch(err => sendJson(res, 400, { error: err.message }));
      return;
    }
    if (requestUrl.pathname === "/api/clients" && req.method === "GET") {
      if (!client || !client.admin) return sendJson(res, 403, { error: "Accès administrateur requis" });
      return sendJson(res, 200, { clients: clients.loadClients().map(clients.publicClient) });
    }
    if (requestUrl.pathname === "/api/clients" && req.method === "POST") {
      if (!client || !client.admin) return sendJson(res, 403, { error: "Accès administrateur requis" });
      readJson(req).then(body => sendJson(res, 201, clients.createClient(body))).catch(err => sendJson(res, 400, { error: err.message })); return;
    }
    const clientRoute = requestUrl.pathname.match(/^\/api\/clients\/([a-z0-9_-]+)(?:\/(rotate))?$/);
    if (clientRoute && req.method === "PUT" && !clientRoute[2]) {
      if (!client || !client.admin) return sendJson(res, 403, { error: "Accès administrateur requis" });
      readJson(req).then(body => sendJson(res, 200, clients.updateClient(clientRoute[1], body, client.id))).catch(err => sendJson(res, 400, { error: err.message })); return;
    }
    if (clientRoute && req.method === "POST" && clientRoute[2] === "rotate") {
      if (!client || !client.admin) return sendJson(res, 403, { error: "Accès administrateur requis" });
      try { return sendJson(res, 200, clients.rotateClientSecrets(clientRoute[1])); } catch (err) { return sendJson(res, 400, { error: err.message }); }
    }
    if (clientRoute && req.method === "DELETE") {
      if (!client || !client.admin) return sendJson(res, 403, { error: "Accès administrateur requis" });
      try { clients.deleteClient(clientRoute[1], client.id); return sendJson(res, 200, { deleted: true }); } catch (err) { return sendJson(res, 400, { error: err.message }); }
    }
    if (req.method === "GET" && DASHBOARD_ASSETS[requestUrl.pathname]) {
      const [fileName, contentType] = DASHBOARD_ASSETS[requestUrl.pathname];
      fs.readFile(path.join(DASHBOARD_DIR, fileName), (err, body) => {
        if (err) return sendJson(res, 500, { error: "Dashboard indisponible" });
        res.writeHead(200, {
          "Content-Type": contentType,
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'",
        });
        res.end(body);
      });
      return;
    }
    return sendJson(res, 404, { error: "Route introuvable" });
  })
  .listen(STATS_PORT, DASHBOARD_HOST, () => {
    console.log(`Dashboard disponible sur http://${DASHBOARD_HOST}:${STATS_PORT}`);
  });
