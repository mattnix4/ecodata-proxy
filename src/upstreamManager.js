const fs = require("fs");
const path = require("path");
const net = require("net");
const tls = require("tls");
const { HttpProxyAgent } = require("http-proxy-agent");
const { HttpsProxyAgent } = require("https-proxy-agent");

const CONFIG_PATH = path.join(__dirname, "..", "config", "upstreams.json");
const CERTS_DIR = path.join(__dirname, "..", "config", "certs");
const DEFAULT_CONFIG = { mode: "direct", fallbackDirect: true, failureCooldownMs: 30000, proxies: [] };

let config = { ...DEFAULT_CONFIG };
let cursor = 0;
const runtime = new Map();
const agents = new Map();

function additionalCaCertificates() {
  try {
    return fs.readdirSync(CERTS_DIR)
      .filter(name => /\.(pem|crt|cer)$/i.test(name))
      .map(name => fs.readFileSync(path.join(CERTS_DIR, name), "utf8"));
  } catch { return []; }
}

function validate(input) {
  if (!input || !["direct", "round-robin"].includes(input.mode)) throw new Error("Mode invalide");
  const proxies = Array.isArray(input.proxies) ? input.proxies : [];
  const normalized = proxies.map((entry, index) => {
    const item = typeof entry === "string" ? { url: entry, enabled: true } : entry;
    let parsed;
    try { parsed = new URL(item.url); } catch { throw new Error(`URL du proxy ${index + 1} invalide`); }
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`Protocole du proxy ${index + 1} non supporté`);
    return { id: item.id || `proxy-${index + 1}`, url: parsed.toString(), enabled: item.enabled !== false };
  });
  return {
    mode: input.mode,
    fallbackDirect: input.fallbackDirect !== false,
    failureCooldownMs: Math.max(1000, Number(input.failureCooldownMs) || 30000),
    proxies: normalized,
  };
}

function load() {
  try { config = validate(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))); }
  catch (err) { console.warn(`[upstream] configuration ignorée: ${err.message}`); config = { ...DEFAULT_CONFIG }; }
}

function save(input) {
  config = validate(input);
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  cursor = 0;
  agents.clear();
  return getConfig();
}

function safeUrl(value) {
  const parsed = new URL(value);
  if (parsed.password) parsed.password = "***";
  return parsed.toString();
}

function getConfig() { return JSON.parse(JSON.stringify(config)); }

function getStatus() {
  return {
    mode: config.mode,
    fallbackDirect: config.fallbackDirect,
    proxies: config.proxies.map(item => {
      const state = runtime.get(item.id) || {};
      return { ...item, url: safeUrl(item.url), requests: state.requests || 0, failures: state.failures || 0, coolingDown: (state.failedUntil || 0) > Date.now() };
    }),
  };
}

function select() {
  if (config.mode === "direct") return null;
  const now = Date.now();
  const available = config.proxies.filter(item => item.enabled && (runtime.get(item.id)?.failedUntil || 0) <= now);
  if (!available.length) return config.fallbackDirect ? null : config.proxies.find(item => item.enabled) || null;
  const selected = available[cursor % available.length];
  cursor += 1;
  const state = runtime.get(selected.id) || { requests: 0, failures: 0, failedUntil: 0 };
  state.requests += 1;
  runtime.set(selected.id, state);
  return selected;
}

function agentFor(item, ca, secureTarget) {
  const key = `${secureTarget ? "https" : "http"}:${item.url}:${ca.length}`;
  if (!agents.has(key)) {
    const Agent = secureTarget ? HttpsProxyAgent : HttpProxyAgent;
    agents.set(key, new Agent(item.url, { ca, keepAlive: true }));
  }
  return agents.get(key);
}

function applyToRequest(ctx, ca) {
  const selected = select();
  ctx.ecoUpstreamId = selected ? selected.id : null;
  if (!selected) return;
  const options = ctx.proxyToServerRequestOptions;
  const effectiveCa = [...ca, ...additionalCaCertificates()];
  if (ctx.isSSL) options.ca = effectiveCa;
  options.agent = agentFor(selected, effectiveCa, ctx.isSSL);
}

function recordFailure(id) {
  if (!id) return;
  const state = runtime.get(id) || { requests: 0, failures: 0, failedUntil: 0 };
  state.failures += 1;
  state.failedUntil = Date.now() + config.failureCooldownMs;
  runtime.set(id, state);
}

function isDirectMode() {
  return config.mode === "direct" || !config.proxies.some(item => item.enabled);
}

function openTunnel(host, port, ca, callback) {
  const selected = select();
  if (!selected) {
    const socket = net.connect(port, host);
    const onError = err => callback(err);
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.removeListener("error", onError);
      callback(null, socket, null);
    });
    return;
  }

  const proxyUrl = new URL(selected.url);
  const proxyPort = Number(proxyUrl.port) || (proxyUrl.protocol === "https:" ? 443 : 80);
  const options = { host: proxyUrl.hostname, port: proxyPort };
  const socket = proxyUrl.protocol === "https:"
    ? tls.connect({ ...options, servername: proxyUrl.hostname, rejectUnauthorized: true, ca })
    : net.connect(options);
  const readyEvent = proxyUrl.protocol === "https:" ? "secureConnect" : "connect";
  let response = Buffer.alloc(0);
  let finished = false;

  const fail = err => {
    if (finished) return;
    finished = true;
    recordFailure(selected.id);
    socket.destroy();
    callback(err);
  };
  socket.once("error", fail);
  socket.once(readyEvent, () => {
    const auth = proxyUrl.username
      ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString("base64")}\r\n`
      : "";
    socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}Connection: keep-alive\r\n\r\n`);
  });
  socket.on("data", function onData(chunk) {
    if (finished) return;
    response = Buffer.concat([response, chunk]);
    if (response.length > 32768) return fail(new Error("Réponse CONNECT upstream trop volumineuse"));
    const boundary = response.indexOf("\r\n\r\n");
    if (boundary < 0) return;
    const statusLine = response.subarray(0, boundary).toString("latin1").split("\r\n")[0];
    const match = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/);
    if (!match || Number(match[1]) !== 200) return fail(new Error(`CONNECT upstream refusé: ${statusLine}`));
    finished = true;
    socket.removeListener("data", onData);
    socket.removeListener("error", fail);
    callback(null, socket, response.subarray(boundary + 4), selected.id);
  });
}

load();
module.exports = { applyToRequest, recordFailure, getConfig, getStatus, save, isDirectMode, openTunnel };
