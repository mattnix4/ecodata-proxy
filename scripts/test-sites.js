/**
 * Teste une liste de sites à travers le proxy éco-data (Puppeteer, en
 * conditions proches d'un vrai navigateur) et génère un rapport chiffré :
 * ratio de compression, taux de pages cassées, temps de chargement — les
 * métriques attendues pour le jalon M0 de la roadmap (30-50 sites réels).
 *
 * Usage :
 *   node server.js                        # dans un terminal, laisser tourner
 *   node scripts/test-sites.js             # dans un autre terminal
 *
 * Résultat : rapport-phase0.md et rapport-phase0.csv dans le dossier courant.
 */
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const PROXY = "127.0.0.1:8081";
const STATS_URL = "http://127.0.0.1:8082";
const SITES_FILE = path.join(__dirname, "sites.json");
const NAV_TIMEOUT_MS = 30000;
const WAIT_AFTER_LOAD_MS = 4000; // laisse le temps aux images lazy-load / requêtes différées de partir

async function resetStats() {
  await fetch(`${STATS_URL}/reset`, { method: "POST" });
}

async function getStats() {
  const res = await fetch(STATS_URL);
  return res.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function testSite(browser, site) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 }); // gabarit mobile, cohérent avec la cible du produit

  const consoleErrors = [];
  page.on("pageerror", (err) => consoleErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  const result = {
    name: site.name,
    url: site.url,
    status: null,
    loadTimeMs: null,
    broken: false,
    errorMessage: null,
    consoleErrorCount: 0,
  };

  const start = Date.now();
  try {
    const response = await page.goto(site.url, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
    result.status = response ? response.status() : null;
    await sleep(WAIT_AFTER_LOAD_MS); // laisse filer les requêtes lazy/différées avant de lire les stats
    result.loadTimeMs = Date.now() - start;
    result.consoleErrorCount = consoleErrors.length;
    if (!response || response.status() >= 400) {
      result.broken = true;
      result.errorMessage = `HTTP ${result.status}`;
    }
  } catch (err) {
    result.broken = true;
    result.errorMessage = err.message;
    result.loadTimeMs = Date.now() - start;
  } finally {
    await page.close();
  }

  return result;
}

function toMarkdownTable(results, statsByHost) {
  const header = "| Site | URL | Statut | Cassé ? | Temps (ms) | Erreurs JS | Ratio compression | Ko économisés |\n|---|---|---|---|---|---|---|---|\n";
  const rows = results.map((r) => {
    const hostStats = findStatsForUrl(statsByHost, r.url);
    const ratio = hostStats ? `${hostStats.compressionRatio}x` : "—";
    const saved = hostStats ? `${Math.round(hostStats.bytesSaved / 1024)} Ko` : "—";
    return `| ${r.name} | ${r.url} | ${r.status ?? "—"} | ${r.broken ? "⚠️ Oui" : "Non"} | ${r.loadTimeMs ?? "—"} | ${r.consoleErrorCount} | ${ratio} | ${saved} |`;
  });
  return header + rows.join("\n");
}

function findStatsForUrl(statsByHost, url) {
  try {
    const hostname = new URL(url).hostname;
    const bareHostname = hostname.replace(/^www\./, "");
    for (const [host, data] of Object.entries(statsByHost)) {
      const bareHost = host.split(":")[0].replace(/^www\./, "");
      if (bareHost === bareHostname) return data;
    }
  } catch {
    return null;
  }
  return null;
}

function toCsv(results, statsByHost) {
  const header = "name,url,status,broken,loadTimeMs,consoleErrorCount,compressionRatio,bytesSaved\n";
  const rows = results.map((r) => {
    const hostStats = findStatsForUrl(statsByHost, r.url);
    return [
      r.name,
      r.url,
      r.status ?? "",
      r.broken,
      r.loadTimeMs ?? "",
      r.consoleErrorCount,
      hostStats ? hostStats.compressionRatio : "",
      hostStats ? hostStats.bytesSaved : "",
    ].join(",");
  });
  return header + rows.join("\n");
}

async function main() {
  if (!fs.existsSync(SITES_FILE)) {
    console.error(`Fichier introuvable : ${SITES_FILE}`);
    process.exit(1);
  }
  const sites = JSON.parse(fs.readFileSync(SITES_FILE, "utf8"));
  console.log(`${sites.length} site(s) à tester via le proxy ${PROXY}...`);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      `--proxy-server=${PROXY}`,
      "--ignore-certificate-errors", // évite d'avoir à installer la CA pour ce test automatisé
      "--no-sandbox", // utile sur certains environnements CI/Windows selon la config
    ],
  });

  const results = [];
  await resetStats(); // stats globales propres avant de démarrer la série

  for (const site of sites) {
    process.stdout.write(`→ ${site.name} (${site.url})... `);
    const r = await testSite(browser, site);
    console.log(r.broken ? `⚠️ CASSÉ (${r.errorMessage})` : `OK (${r.loadTimeMs} ms, ${r.consoleErrorCount} erreurs JS)`);
    results.push(r);
  }

  await browser.close();

  const finalStats = await getStats();

  const brokenCount = results.filter((r) => r.broken).length;
  const summary = `# Rapport Phase 0 — Test de compression sur ${sites.length} sites

Généré le ${new Date().toISOString()}

## Résumé

- Sites testés : ${sites.length}
- Sites cassés : ${brokenCount} (${((brokenCount / sites.length) * 100).toFixed(0)}%)
- Ratio de compression global (toutes images confondues) : **${finalStats.compressionRatio}x**
- Total économisé : ${(finalStats.bytesSaved / 1024 / 1024).toFixed(2)} Mo sur ${(finalStats.bytesOriginal / 1024 / 1024).toFixed(2)} Mo d'images
- Domaines en tunnel de contournement (pinning/anti-bot détecté) : ${finalStats.bypassedHosts.length}
- Encodages non supportés rencontrés : ${JSON.stringify(finalStats.unsupportedEncodings)}

## Détail par site

${toMarkdownTable(results, finalStats.byHost)}

## Domaines contournés (tunnel brut, pas de compression)

${finalStats.bypassedHosts.length ? finalStats.bypassedHosts.map((h) => `- ${h}`).join("\n") : "(aucun)"}

---
⚠️ Le "ratio de compression" et "Ko économisés" par site ne comptent que les
images transformées avec succès par le proxy sur le domaine principal de la
page — les sous-domaines (CDN d'images séparé, etc.) et les ressources
chargées après la fenêtre d'attente de ${WAIT_AFTER_LOAD_MS} ms ne sont pas
comptabilisés. Le chiffre global ci-dessus (toutes requêtes confondues) est
plus représentatif que la ventilation par site pour cette raison.
`;

  fs.writeFileSync("rapport-phase0.md", summary);
  fs.writeFileSync("rapport-phase0.csv", toCsv(results, finalStats.byHost));
  fs.writeFileSync("rapport-phase0-stats-brutes.json", JSON.stringify(finalStats, null, 2));

  console.log("\nRapport généré : rapport-phase0.md, rapport-phase0.csv, rapport-phase0-stats-brutes.json");
  console.log(`${brokenCount}/${sites.length} sites cassés — ratio de compression global : ${finalStats.compressionRatio}x`);
}

main().catch((err) => {
  console.error("Erreur fatale:", err);
  process.exit(1);
});
