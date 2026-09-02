const managerUrl = "chrome://certificate-manager/localcerts/usercerts";
chrome.runtime.sendMessage({ type: "status" }, session => {
  if (!session?.dashboardUrl) return;
  document.getElementById("downloadCa").href = `${session.dashboardUrl.replace(/\/$/, "")}/ca.pem`;
});
document.getElementById("copyAddress").addEventListener("click", async () => { await navigator.clipboard.writeText(managerUrl); document.getElementById("copyAddress").textContent = "Copié"; });
const failed = new URLSearchParams(location.search).get("failed");
if (failed) { try { document.getElementById("failedSite").textContent = `Site interrompu : ${new URL(failed).hostname}`; } catch {} }
