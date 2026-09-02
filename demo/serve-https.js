const https = require("https");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const express = require("express");

const app = express();
app.use(express.static(path.join(__dirname)));

app.get("/gzip-page", (req, res) => {
  const html = `<html><head><title>Page gzip</title>
  <script src="https://www.google-analytics.com/analytics.js"></script></head>
  <body><h1>Contenu compressé en gzip</h1><img src="/hero.jpg"></body></html>`;
  res.set("Content-Encoding", "gzip");
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(zlib.gzipSync(html));
});

app.get("/zstd-page", (req, res) => {
  // Simule un encodage qu'on ne sait PAS décompresser (zstd) : on envoie du
  // contenu qui n'est PAS réellement zstd-compressé (Node ne sait pas
  // l'encoder nativement) mais avec l'en-tête qui l'annonce — suffisant pour
  // vérifier qu'on ne casse PAS le Content-Encoding ni ne tente de le lire.
  const html = "<html><body><h1>Simulation zstd</h1></body></html>";
  res.set("Content-Encoding", "zstd");
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(Buffer.from(html)); // pas vraiment compressé, juste pour le test du header
});

const options = {
  key: fs.readFileSync("/tmp/selfsigned/key.pem"),
  cert: fs.readFileSync("/tmp/selfsigned/cert.pem"),
};

https.createServer(options, app).listen(9443, () => {
  console.log("Site de démo HTTPS sur https://localhost:9443/heavy-page.html");
});

