importScripts("config.js");
const DEPLOYMENT = self.ECODATA_CONFIG || {};
const DEFAULTS = { host: DEPLOYMENT.proxyHost || "127.0.0.1", port: DEPLOYMENT.proxyPort || 8081, dashboardUrl: DEPLOYMENT.dashboardUrl || "http://127.0.0.1:8082", directList: [], connected: false };
let proxySessionRefresh;
function normalizeDirectList(value) { const entries = Array.isArray(value) ? value : String(value || "").split(","); return [...new Set(entries.map(item => String(item).trim().toLowerCase()).filter(item => item && /^[a-z0-9.*:_-]+$/.test(item)))].slice(0, 100); }

async function loadClientDirectList(clientId) {
  const stored = await chrome.storage.local.get(["clientDirectLists", "directList"]);
  const lists = stored.clientDirectLists || {};
  if (Object.prototype.hasOwnProperty.call(lists, clientId)) return normalizeDirectList(lists[clientId]);
  // Migrate the former shared setting to the first account that uses it.
  const migrated = normalizeDirectList(stored.directList);
  lists[clientId] = migrated;
  await chrome.storage.local.set({ clientDirectLists: lists });
  return migrated;
}

async function saveClientDirectList(clientId, directList) {
  if (!clientId) throw new Error("Compte utilisateur indisponible");
  const stored = await chrome.storage.local.get("clientDirectLists");
  const lists = { ...(stored.clientDirectLists || {}), [clientId]: normalizeDirectList(directList) };
  await chrome.storage.local.set({ clientDirectLists: lists, directList: lists[clientId] });
  return lists[clientId];
}

async function currentSession() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(null)) };
}

async function deviceId() {
  const stored = await chrome.storage.local.get("deviceId");
  if (stored.deviceId) return stored.deviceId;
  const value = crypto.randomUUID();
  await chrome.storage.local.set({ deviceId: value });
  return value;
}

async function resetProxyAuthentication() {
  // Chrome can reuse accepted Basic proxy credentials without firing
  // onAuthRequired again. Remove the old proxy configuration and flush its
  // in-memory webRequest state before another account starts browsing.
  await chrome.proxy.settings.clear({ scope: "regular" });
  if (chrome.webRequest.handlerBehaviorChanged) {
    await chrome.webRequest.handlerBehaviorChanged();
  }
}

async function applyProxy(session) {
  if (!session.connected) {
    await resetProxyAuthentication();
    await applyPrivacyProtection(false);
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  await resetProxyAuthentication();
  await chrome.proxy.settings.set({
    scope: "regular",
    value: {
      mode: "fixed_servers",
      rules: {
        singleProxy: { scheme: "http", host: session.host, port: Number(session.port) },
        bypassList: [...new Set(["localhost", "127.0.0.1", session.host, ...normalizeDirectList(session.directList)])]
      }
    }
  });
  await applyPrivacyProtection(true);
  await chrome.action.setBadgeBackgroundColor({ color: "#28d47d" });
  await chrome.action.setBadgeText({ text: "ON" });
}

async function setPrivacySetting(setting, value, enabled) {
  if (!setting) return;
  if (enabled) await setting.set({ value, scope: "regular" });
  else await setting.clear({ scope: "regular" });
}

async function applyPrivacyProtection(enabled) {
  const network = chrome.privacy && chrome.privacy.network;
  if (!network) return;
  await Promise.all([
    setPrivacySetting(network.networkPredictionEnabled, false, enabled),
    setPrivacySetting(network.webRTCIPHandlingPolicy, "disable_non_proxied_udp", enabled),
  ]);
}

async function fetchClientStats(session) {
  const response = await fetch(`${session.dashboardUrl.replace(/\/$/, "")}/api/extension/stats`, {
    headers: { "X-EcoData-User": session.username, "X-EcoData-Password": session.password },
    cache: "no-store"
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(response.status === 401 ? "Utilisateur proxy ou mot de passe incorrect" : (result.error || "Serveur EcoData indisponible")); error.authInvalid = response.status === 401; throw error; }
  return result;
}

async function loginClient(session) {
  const response = await fetch(`${session.dashboardUrl.replace(/\/$/, "")}/api/extension/login`, { method: "POST", headers: { "X-EcoData-User": session.username, "X-EcoData-Password": session.password, "X-EcoData-Device": await deviceId() }, cache: "no-store" });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Connexion EcoData impossible");
  return result;
}

async function refreshProxySession(session) {
  if (!proxySessionRefresh) {
    proxySessionRefresh = loginClient(session)
      .then(async identity => {
        const credentials = {
          proxySessionUsername: identity.proxySession.username,
          proxySessionPassword: identity.proxySession.password
        };
        await chrome.storage.local.set(credentials);
        return credentials;
      })
      .finally(() => { proxySessionRefresh = null; });
  }
  return proxySessionRefresh;
}

async function logoutClient(session) {
  if (!session.username || !session.password) return;
  await fetch(`${session.dashboardUrl.replace(/\/$/, "")}/api/extension/logout`, {
    method: "POST",
    headers: { "X-EcoData-User": session.username, "X-EcoData-Password": session.password, "X-EcoData-Device": await deviceId() },
    cache: "no-store"
  }).catch(() => {});
}

async function ensureDashboardIdentity(session) {
  if (!session.username || !session.password) { const error = new Error("Veuillez reconnecter votre compte"); error.authInvalid = true; error.needsReconnect = true; throw error; }
  return session;
}

chrome.runtime.onInstalled.addListener(async () => applyProxy(await currentSession()));
chrome.runtime.onStartup.addListener(async () => applyProxy(await currentSession()));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "connect") {
    const session = { host: DEFAULTS.host, port: DEFAULTS.port, dashboardUrl: DEFAULTS.dashboardUrl, directList: normalizeDirectList(message.directList), username: message.username.trim(), password: message.password, connected: true };
    if (!session.host || !session.username || !session.password || !Number.isInteger(session.port) || session.port < 1 || session.port > 65535) { sendResponse({ ok: false, error: "Paramètres de connexion invalides" }); return; }
    loginClient(session).then(async identity => { session.clientId = identity.clientId; session.proxySessionUsername = identity.proxySession.username; session.proxySessionPassword = identity.proxySession.password; session.directList = await loadClientDirectList(identity.clientId); return fetchClientStats(session); }).then(data => chrome.storage.local.set(session).then(() => applyProxy(session)).then(() => sendResponse({ ok: true, data }))).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "disconnect") {
    currentSession().then(session => logoutClient(session)).then(() => chrome.storage.local.set({ connected: false, password: "", clientId: "", dashboardToken: "", proxySessionUsername: "", proxySessionPassword: "" })).then(() => applyProxy({ connected: false })).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === "status") { currentSession().then(session => sendResponse({ ...session, needsReconnect: !!session.connected && (!session.username || !session.password), password: undefined, dashboardToken: undefined, proxySessionPassword: undefined })); return true; }
  if (message.type === "updateDirectList") { currentSession().then(async session => { session.directList = await saveClientDirectList(session.clientId, message.directList); await applyProxy(session); sendResponse({ ok: true, directList: session.directList }); }).catch(error => sendResponse({ ok: false, error: error.message })); return true; }
  if (message.type === "stats") {
    currentSession().then(async session => {
      if (!session.connected) throw new Error("Session déconnectée");
      const authenticatedSession = await ensureDashboardIdentity(session);
      sendResponse({ ok: true, data: await fetchClientStats(authenticatedSession) });
    }).catch(error => sendResponse({ ok: false, error: error.message, authInvalid: !!error.authInvalid }));
    return true;
  }
});

chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (!details.isProxy) { callback({}); return; }
    currentSession().then(async session => {
      if (!session.connected || !session.username || !session.password) callback({ cancel: true });
      else {
        // A challenge means the cached session was absent, expired, revoked,
        // or lost after a server restart. Always mint a fresh one.
        const credentials = await refreshProxySession(session);
        callback({ authCredentials: { username: credentials.proxySessionUsername, password: credentials.proxySessionPassword } });
      }
    }).catch(() => callback({ cancel: true }));
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"]
);

chrome.webNavigation.onErrorOccurred.addListener(async details => {
  if (details.frameId !== 0 || details.error !== "net::ERR_CERT_AUTHORITY_INVALID") return;
  const session = await currentSession();
  if (!session.connected) return;
  const setupUrl = new URL(chrome.runtime.getURL("setup.html"));
  setupUrl.searchParams.set("failed", details.url);
  await chrome.tabs.update(details.tabId, { url: setupUrl.toString() });
}, { url: [{ schemes: ["http", "https"] }] });
