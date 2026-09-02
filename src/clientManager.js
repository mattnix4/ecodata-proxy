const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const CLIENTS_PATH = path.join(__dirname, "..", "config", "clients.json");
const proxySessions = new Map();
const deviceSessions = new Map();
const PROXY_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const randomSecret = bytes => crypto.randomBytes(bytes).toString("base64url");
function ensureConfig() {
  if (fs.existsSync(CLIENTS_PATH)) return;
  const client = { id: "admin", name: "Administrateur", proxyUsername: "admin", proxyPassword: randomSecret(18), dashboardToken: randomSecret(32), admin: true, enabled: true };
  fs.mkdirSync(path.dirname(CLIENTS_PATH), { recursive: true });
  fs.writeFileSync(CLIENTS_PATH, `${JSON.stringify({ clients: [client] }, null, 2)}\n`, { mode: 0o600 });
  console.warn(`[clients] Premier compte créé dans ${CLIENTS_PATH}`);
}
function loadClients() { ensureConfig(); const parsed = JSON.parse(fs.readFileSync(CLIENTS_PATH, "utf8")); return Array.isArray(parsed.clients) ? parsed.clients : []; }
function saveClients(clientList) { const temp = `${CLIENTS_PATH}.${process.pid}.tmp`; fs.writeFileSync(temp, `${JSON.stringify({ clients: clientList }, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temp, CLIENTS_PATH); }
function publicClient(c) { return { id: c.id, name: c.name, proxyUsername: c.proxyUsername, admin: !!c.admin, enabled: c.enabled !== false }; }
function createClient(input = {}) { const list = loadClients(), id = String(input.id || "").trim().toLowerCase(), username = String(input.proxyUsername || id).trim(); if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(id)) throw new Error("Identifiant invalide (2 à 40 caractères : lettres, chiffres, _ ou -)"); if (!String(input.name || "").trim() || !username) throw new Error("Le nom et l’utilisateur proxy sont requis"); if (list.some(c => c.id === id)) throw new Error("Cet identifiant existe déjà"); if (list.some(c => c.proxyUsername === username)) throw new Error("Cet utilisateur proxy existe déjà"); const c = { id, name: String(input.name).trim(), proxyUsername: username, proxyPassword: randomSecret(18), dashboardToken: randomSecret(32), admin: !!input.admin, enabled: input.enabled !== false }; list.push(c); saveClients(list); return { ...publicClient(c), proxyPassword: c.proxyPassword, dashboardToken: c.dashboardToken }; }
function updateClient(id, input = {}, actorId) { const list = loadClients(), index = list.findIndex(c => c.id === id); if (index < 0) throw new Error("Utilisateur introuvable"); const old = list[index], name = String(input.name ?? old.name).trim(), username = String(input.proxyUsername ?? old.proxyUsername).trim(); if (!name || !username) throw new Error("Le nom et l’utilisateur proxy sont requis"); if (list.some((c, i) => i !== index && c.proxyUsername === username)) throw new Error("Cet utilisateur proxy existe déjà"); const next = { ...old, name, proxyUsername: username, admin: input.admin === undefined ? !!old.admin : !!input.admin, enabled: input.enabled === undefined ? old.enabled !== false : !!input.enabled }; if (id === actorId && (!next.admin || !next.enabled)) throw new Error("Vous ne pouvez pas désactiver votre propre accès administrateur"); list[index] = next; saveClients(list); return publicClient(next); }
function rotateClientSecrets(id) { const list = loadClients(), c = list.find(item => item.id === id); if (!c) throw new Error("Utilisateur introuvable"); c.proxyPassword = randomSecret(18); c.dashboardToken = randomSecret(32); saveClients(list); return { ...publicClient(c), proxyPassword: c.proxyPassword, dashboardToken: c.dashboardToken }; }
function deleteClient(id, actorId) { if (id === actorId) throw new Error("Vous ne pouvez pas supprimer votre propre compte"); const list = loadClients(), next = list.filter(c => c.id !== id); if (next.length === list.length) throw new Error("Utilisateur introuvable"); saveClients(next); }
function safeEqual(left, right) { const a = Buffer.from(String(left)), b = Buffer.from(String(right)); return a.length === b.length && crypto.timingSafeEqual(a, b); }
function issueProxySession(client, deviceId) {
  const device = String(deviceId || "").trim();
  if (!device || device.length > 200) throw new Error("Identifiant d’appareil invalide");
  const previousUsername = deviceSessions.get(device);
  if (previousUsername) proxySessions.delete(previousUsername);
  const username = `eco-session-${randomSecret(18)}`;
  const password = randomSecret(32);
  proxySessions.set(username, { clientId: client.id, password, expiresAt: Date.now() + PROXY_SESSION_TTL_MS });
  deviceSessions.set(device, username);
  return { username, password };
}
function revokeProxySession(deviceId, clientId) {
  const device = String(deviceId || "").trim();
  const username = deviceSessions.get(device);
  if (!username) return false;
  const session = proxySessions.get(username);
  if (clientId && session && session.clientId !== clientId) return false;
  proxySessions.delete(username);
  deviceSessions.delete(device);
  return true;
}
function authenticateProxySession(username, password) {
  const session = proxySessions.get(username);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) { proxySessions.delete(username); return null; }
  if (!safeEqual(session.password, password)) return null;
  return loadClients().find(c => c.enabled !== false && c.id === session.clientId) || null;
}
function authenticateProxy(header) {
  if (!header || !header.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8"), split = decoded.indexOf(":");
    if (split < 0) return null;
    const username = decoded.slice(0, split), password = decoded.slice(split + 1);
    const sessionClient = authenticateProxySession(username, password);
    if (sessionClient) return sessionClient;
    // Static credentials are used only to obtain an extension session. Keeping
    // them valid at the proxy would let Chrome's auth cache retain an old user.
    if (process.env.ECODATA_ALLOW_STATIC_PROXY_AUTH !== "1") return null;
    return loadClients().find(c => c.enabled !== false && safeEqual(c.proxyUsername, username) && safeEqual(c.proxyPassword, password)) || null;
  } catch { return null; }
}
function authenticateProxyCredentials(username, password) { if (!username || !password) return null; return loadClients().find(c => c.enabled !== false && safeEqual(c.proxyUsername, username) && safeEqual(c.proxyPassword, password)) || null; }
function authenticateDashboard(clientId, token) { if (!clientId || !token) return null; return loadClients().find(c => c.enabled !== false && c.id === clientId && safeEqual(c.dashboardToken, token)) || null; }
ensureConfig();
module.exports = { authenticateProxy, authenticateProxyCredentials, authenticateDashboard, issueProxySession, revokeProxySession, loadClients, publicClient, createClient, updateClient, rotateClientSecrets, deleteClient };
