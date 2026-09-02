const $ = (id) => document.getElementById(id);
const state = { paused: false, history: [], timer: null, lastData: null };
const credentials = new URLSearchParams(location.hash.slice(1));
const clientId = credentials.get("client");
const dashboardToken = credentials.get("token");

function apiFetch(url, options = {}) {
  if (!clientId || !dashboardToken) return Promise.reject(new Error("Lien dashboard incomplet"));
  return fetch(url, { ...options, headers: { ...(options.headers || {}), "X-Client-Id": clientId, "Authorization": `Bearer ${dashboardToken}` } });
}

function formatBytes(value = 0) {
  if (!Number.isFinite(value) || value <= 0) return "0 o";
  const units = ["o", "Ko", "Mo", "Go", "To"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** index;
  return `${scaled.toLocaleString("fr-FR", { maximumFractionDigits: scaled >= 100 ? 0 : 1 })} ${units[index]}`;
}

function formatNumber(value = 0) { return Number(value).toLocaleString("fr-FR"); }
function plural(value, one, many = `${one}s`) { return `${formatNumber(value)} ${value === 1 ? one : many}`; }
function escapeHtml(value) { const node = document.createElement("span"); node.textContent = String(value); return node.innerHTML; }

function setConnection(mode, label) {
  const pill = document.querySelector(".live-pill");
  pill.className = `live-pill ${mode || ""}`;
  $("connectionLabel").textContent = label;
}

function renderChart() {
  const svg = $("activityChart");
  const data = state.history;
  $("chartEmpty").style.display = data.length < 2 ? "grid" : "none";
  const grid = [30, 90, 150, 210].map(y => `<line class="grid-line" x1="0" y1="${y}" x2="800" y2="${y}"/>`).join("");
  if (data.length < 2) { svg.innerHTML = grid; return; }
  const maxRequests = Math.max(...data.map(x => x.requests), 1);
  const maxSaved = Math.max(...data.map(x => x.saved), 1);
  const points = (key, max) => data.map((item, index) => {
    const x = index * (800 / Math.max(data.length - 1, 1));
    const y = 235 - (item[key] / max) * 195;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const primary = points("requests", maxRequests);
  const secondary = points("saved", maxSaved);
  svg.innerHTML = `<defs><linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7cf5b3" stop-opacity=".22"/><stop offset="1" stop-color="#7cf5b3" stop-opacity="0"/></linearGradient></defs>${grid}<polygon class="chart-area" points="0,235 ${primary} 800,235"/><polyline class="line-secondary" points="${secondary}"/><polyline class="line-primary" points="${primary}"/>`;
}

function renderHosts(byHost = {}) {
  const entries = Object.entries(byHost).sort((a, b) => b[1].requests - a[1].requests).slice(0, 10);
  $("hostsBadge").textContent = plural(Object.keys(byHost).length, "hôte");
  $("hostsEmpty").style.display = entries.length ? "none" : "grid";
  $("hostsTable").innerHTML = entries.map(([host, item]) => `<tr><td title="${escapeHtml(host)}">${escapeHtml(host)}</td><td>${formatNumber(item.requests)}</td><td>${formatNumber(item.imagesCompressed)}</td><td>${formatNumber(item.trackersStripped)}</td><td class="saving">${formatBytes(Math.max(item.bytesSaved, 0))}</td></tr>`).join("");
}

function render(data) {
  state.lastData = data;
  const saved = Math.max(Number(data.bytesSaved) || 0, 0);
  const original = Number(data.bytesOriginal) || 0;
  const served = Number(data.bytesServed) || 0;
  const efficiency = original ? Math.max(0, Math.min(100, saved / original * 100)) : 0;
  const hosts = data.hostsSeen || [];
  const bypasses = data.bypassedHosts || [];
  const encodings = data.unsupportedEncodings || {};
  const encodingTotal = Object.values(encodings).reduce((sum, count) => sum + count, 0);

  $("bytesSaved").textContent = formatBytes(saved);
  $("requests").textContent = formatNumber(data.requests);
  $("imagesCompressed").textContent = formatNumber(data.imagesCompressed);
  $("trackersStripped").textContent = formatNumber(data.trackersStripped);
  $("hostCount").textContent = plural(hosts.length, "domaine");
  $("averageSaving").textContent = `${formatBytes(data.imagesCompressed ? saved / data.imagesCompressed : 0)} économisé / image`;
  $("savedPercent").textContent = `${efficiency.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} % du volume image`;
  $("savedProgress").style.width = `${efficiency}%`;
  $("efficiency").textContent = `${Math.round(efficiency)}%`;
  $("gauge").style.setProperty("--value", `${efficiency * 3.6}deg`);
  $("bytesOriginal").textContent = formatBytes(original);
  $("bytesServed").textContent = formatBytes(served);
  $("compressionRatio").textContent = `${Number(data.compressionRatio || 0).toLocaleString("fr-FR")}×`;
  $("bypassCount").textContent = formatNumber(bypasses.length);
  $("bypassSummary").textContent = bypasses.length ? plural(bypasses.length, "connexion directe") : "Aucun domaine";
  $("encodingCount").textContent = formatNumber(encodingTotal);
  $("encodingSummary").textContent = encodingTotal ? Object.entries(encodings).map(([key, count]) => `${key}: ${count}`).join(" · ") : "Aucun encodage";
  $("bypassList").innerHTML = bypasses.slice(0, 8).map(host => `<span class="host-chip" title="${escapeHtml(host)}">${escapeHtml(host)}</span>`).join("");
  $("updatedAt").textContent = new Date().toLocaleTimeString("fr-FR");
  $("footerStatus").textContent = data.requests ? `${formatNumber(data.requests)} requêtes analysées` : "En attente de trafic";
  state.history.push({ requests: Number(data.requests) || 0, saved });
  if (state.history.length > 40) state.history.shift();
  renderHosts(data.byHost);
  renderUpstreamStatus(data.upstreams);
  renderChart();
}

function renderUpstreamStatus(status = { mode: "direct", proxies: [] }) {
  const enabled = status.proxies.filter(item => item.enabled);
  $("upstreamBadge").textContent = status.mode === "direct" ? "Mode direct" : `${enabled.length} upstream(s)`;
  $("upstreamRuntime").innerHTML = status.proxies.map(item => `<div class="runtime-proxy ${item.coolingDown ? "bad" : ""}"><strong>${escapeHtml(item.url)}</strong><span>${item.requests} req · ${item.failures} erreur(s)${item.coolingDown ? " · pause" : ""}</span></div>`).join("");
}

async function loadUpstreamConfig() {
  try {
    const response = await apiFetch("/api/upstreams", { cache: "no-store" });
    const config = await response.json();
    $("upstreamMode").value = config.mode;
    $("fallbackDirect").checked = config.fallbackDirect;
    $("proxyUrls").value = (config.proxies || []).map(item => item.url).join("\n");
  } catch { toast("Configuration upstream indisponible"); }
}

async function refresh() {
  if (state.paused) return;
  try {
    const response = await apiFetch("/api/stats", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const isAdmin = !!(data.client && data.client.admin);
    document.querySelector(".upstream-panel").hidden = !isAdmin;
    $("usersPanel").hidden = !isAdmin;
    if (isAdmin && !state.clientsLoaded) { state.clientsLoaded = true; loadClients(); }
    render(data);
    setConnection("", "En direct");
    $("proxyStatus").textContent = "Collecte en cours";
  } catch (error) {
    setConnection("offline", "Hors ligne");
    $("proxyStatus").textContent = "Données indisponibles";
  }
}

function toast(message) {
  $("toast").textContent = message; $("toast").classList.add("show");
  setTimeout(() => $("toast").classList.remove("show"), 2200);
}

$("pauseButton").addEventListener("click", () => {
  state.paused = !state.paused;
  $("pauseButton").textContent = state.paused ? "▶" : "Ⅱ";
  $("pauseButton").title = state.paused ? "Reprendre" : "Suspendre";
  setConnection(state.paused ? "paused" : "", state.paused ? "En pause" : "En direct");
  if (!state.paused) refresh();
});

$("resetButton").addEventListener("click", async () => {
  if (!confirm("Réinitialiser toutes les statistiques de cette session ?")) return;
  try {
    const response = await apiFetch("/api/reset", { method: "POST" });
    if (!response.ok) throw new Error();
    state.history = [];
    toast("Statistiques réinitialisées");
    await refresh();
  } catch { toast("Réinitialisation impossible"); }
});

$("saveUpstreams").addEventListener("click", async () => {
  const proxies = $("proxyUrls").value.split(/\r?\n/).map(value => value.trim()).filter(Boolean).map((url, index) => ({ id: `proxy-${index + 1}`, url, enabled: true }));
  try {
    const response = await apiFetch("/api/upstreams", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: $("upstreamMode").value, fallbackDirect: $("fallbackDirect").checked, failureCooldownMs: 30000, proxies }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    toast("Configuration upstream enregistrée");
    await refresh();
  } catch (err) { toast(err.message || "Configuration invalide"); }
});

let managedClients = [];
function renderClients() {
  $("userCount").textContent = plural(managedClients.length, "utilisateur");
  $("activeUserCount").textContent = `${managedClients.filter(c => c.enabled).length} actif(s)`;
  $("adminCount").textContent = `${managedClients.filter(c => c.admin).length} administrateur(s)`;
  $("usersTable").innerHTML = managedClients.map(c => `<tr><td><div class="user-cell"><strong>${escapeHtml(c.name)}</strong><small>${escapeHtml(c.id)}</small></div></td><td>${escapeHtml(c.proxyUsername)}</td><td><span class="role-badge ${c.admin ? "admin" : ""}">${c.admin ? "Admin" : "Client"}</span></td><td><span class="status-badge ${c.enabled ? "active" : "disabled"}">${c.enabled ? "Actif" : "Désactivé"}</span></td><td><div class="table-actions"><button data-action="edit" data-id="${escapeHtml(c.id)}">Modifier</button><button data-action="rotate" data-id="${escapeHtml(c.id)}">Régénérer</button><button class="danger" data-action="delete" data-id="${escapeHtml(c.id)}">Supprimer</button></div></td></tr>`).join("");
}
async function loadClients() { try { const response = await apiFetch("/api/clients", { cache: "no-store" }), result = await response.json(); if (!response.ok) throw new Error(result.error); managedClients = result.clients || []; renderClients(); } catch (err) { toast(err.message || "Utilisateurs indisponibles"); } }
function showCredentials(result) { const link = `${location.origin}/#client=${encodeURIComponent(result.id)}&token=${encodeURIComponent(result.dashboardToken)}`; $("createdProxyPassword").textContent = result.proxyPassword; $("createdDashboardLink").textContent = link; $("credentialsDialog").showModal(); }
$("newUser").addEventListener("click", () => { $("userForm").reset(); $("editUserId").value = ""; $("userId").disabled = false; $("userEnabled").checked = true; $("userDialogTitle").textContent = "Créer un utilisateur"; $("userDialog").showModal(); });
$("userForm").addEventListener("submit", async event => { event.preventDefault(); if (!event.submitter || event.submitter.value === "cancel") return $("userDialog").close(); const editId = $("editUserId").value, body = { id: $("userId").value, name: $("userName").value, proxyUsername: $("proxyUsername").value, admin: $("userAdmin").checked, enabled: $("userEnabled").checked }; try { const response = await apiFetch(editId ? `/api/clients/${editId}` : "/api/clients", { method: editId ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), result = await response.json(); if (!response.ok) throw new Error(result.error); $("userDialog").close(); await loadClients(); if (!editId) showCredentials(result); else toast("Utilisateur mis à jour"); } catch (err) { toast(err.message || "Enregistrement impossible"); } });
$("usersTable").addEventListener("click", async event => { const button = event.target.closest("button[data-action]"); if (!button) return; const item = managedClients.find(c => c.id === button.dataset.id); if (!item) return; if (button.dataset.action === "edit") { $("editUserId").value = item.id; $("userId").value = item.id; $("userId").disabled = true; $("userName").value = item.name; $("proxyUsername").value = item.proxyUsername; $("userAdmin").checked = item.admin; $("userEnabled").checked = item.enabled; $("userDialogTitle").textContent = "Modifier l’utilisateur"; return $("userDialog").showModal(); } if (button.dataset.action === "delete" && !confirm(`Supprimer définitivement ${item.name} ?`)) return; if (button.dataset.action === "rotate" && !confirm(`Régénérer les accès de ${item.name} ? Les anciens cesseront immédiatement de fonctionner.`)) return; try { const response = await apiFetch(`/api/clients/${item.id}${button.dataset.action === "rotate" ? "/rotate" : ""}`, { method: button.dataset.action === "delete" ? "DELETE" : "POST" }), result = await response.json(); if (!response.ok) throw new Error(result.error); await loadClients(); if (button.dataset.action === "rotate") showCredentials(result); else toast("Utilisateur supprimé"); } catch (err) { toast(err.message || "Action impossible"); } });
document.querySelector("[data-close-credentials]").addEventListener("click", () => $("credentialsDialog").close());
$("copyCredentials").addEventListener("click", async () => { const text = `Mot de passe proxy: ${$("createdProxyPassword").textContent}\nDashboard: ${$("createdDashboardLink").textContent}`; try { await navigator.clipboard.writeText(text); toast("Identifiants copiés"); } catch { toast("Copie impossible"); } });

refresh();
loadUpstreamConfig();
state.timer = setInterval(refresh, 2000);
