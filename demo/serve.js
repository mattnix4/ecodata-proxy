// Simule un "site lourd" cible pour tester le proxy en local (sans dépendre
// d'un accès réseau externe, indisponible dans ce bac à sable).
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.DEMO_PORT || 9090;

app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`Site de démo (cible) démarré sur http://localhost:${PORT}/heavy-page.html`);
});
