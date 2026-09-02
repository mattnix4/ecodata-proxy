const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const sharp = require("sharp");

const { decompressBody, isSupportedEncoding } = require("../src/decompress");
const { transformHtml } = require("../src/htmlTransform");
const { isCompressibleImage, compressImage } = require("../src/imageCompress");
const { isCertificateError } = require("../src/certErrors");
const stats = require("../src/stats");
const clients = require("../src/clientManager");

test("decompresse gzip et brotli", async () => {
  const source = Buffer.from("bonjour eco-data");
  assert.deepEqual((await decompressBody(zlib.gzipSync(source), "gzip")).buffer, source);
  assert.deepEqual((await decompressBody(zlib.brotliCompressSync(source), "br")).buffer, source);
  assert.equal(isSupportedEncoding("zstd"), false);
});

test("ne presente jamais un gzip invalide comme du texte", async () => {
  const result = await decompressBody(Buffer.from("invalide"), "gzip");
  assert.equal(result.truncated, true);
  assert.equal(result.buffer.length, 0);
});

test("retire les trackers sans rendre l'image principale lazy", () => {
  const result = transformHtml('<html><body><script src="https://google-analytics.com/a.js"></script><img src="hero.jpg"><img src="suite.jpg"></body></html>');
  assert.equal(result.strippedTrackers, 1);
  assert.doesNotMatch(result.html, /google-analytics/);
  assert.doesNotMatch(result.html, /src="hero.jpg" loading="lazy"/);
  assert.match(result.html, /src="suite.jpg" loading="lazy"/);
});

test("conserve le type MIME pendant la compression", async () => {
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: "red" } }).png().toBuffer();
  const result = await compressImage(png, "image/png");
  assert.equal(result.contentType, "image/png");
  assert.equal((await sharp(result.buffer).metadata()).format, "png");
  assert.equal(isCompressibleImage("image/bmp"), false);
});

test("reconnait les erreurs de chaine de certificat", () => {
  assert.equal(isCertificateError(new Error("unable to verify the first certificate")), true);
  assert.equal(isCertificateError({ code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" }), true);
  assert.equal(isCertificateError(new Error("socket hang up")), false);
});

test("isole les statistiques de chaque client", () => {
  stats.resetStats("client-a"); stats.resetStats("client-b");
  stats.recordRequest("example.com", "client-a");
  stats.recordImageCompression(1000, 400, "example.com", "client-a");
  stats.recordImageCompression(800, 500, "example.org", "client-b");
  assert.equal(stats.getStats("client-a").requests, 1);
  assert.equal(stats.getStats("client-b").requests, 0);
  assert.equal(stats.getStats("client-a").bytesSaved, 600);
  assert.equal(stats.getStats("client-b").bytesSaved, 300);
  assert.equal(stats.getStats("client-a").byHost["example.com"].bytesSaved, 600);
  assert.equal(stats.getStats("client-b").byHost["example.org"].bytesSaved, 300);
  assert.throws(() => stats.recordImageCompression(100, 50, "example.net"), /Client ID required/);
});

test("remplace la session proxy quand un appareil change de compte", () => {
  const configured = clients.loadClients().filter(client => client.enabled !== false);
  assert.ok(configured.length >= 2, "deux clients de test sont requis");
  const first = clients.issueProxySession(configured[0], "test-extension-device");
  const firstHeader = `Basic ${Buffer.from(`${first.username}:${first.password}`).toString("base64")}`;
  assert.equal(clients.authenticateProxy(firstHeader).id, configured[0].id);

  const second = clients.issueProxySession(configured[1], "test-extension-device");
  const secondHeader = `Basic ${Buffer.from(`${second.username}:${second.password}`).toString("base64")}`;
  assert.equal(clients.authenticateProxy(firstHeader), null);
  assert.equal(clients.authenticateProxy(secondHeader).id, configured[1].id);
  assert.equal(clients.revokeProxySession("test-extension-device", configured[1].id), true);
  assert.equal(clients.authenticateProxy(secondHeader), null);
});
