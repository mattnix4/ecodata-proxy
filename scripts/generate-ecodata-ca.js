const fs = require("fs");
const path = require("path");
const forge = require("node-forge");

const outputDir = path.resolve(process.argv[2] || ".ecodata-mitm-certs");
const certsDir = path.join(outputDir, "certs");
const keysDir = path.join(outputDir, "keys");
fs.mkdirSync(certsDir, { recursive: true });
fs.mkdirSync(keysDir, { recursive: true });

const keys = forge.pki.rsa.generateKeyPair(3072);
const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16)).replace(/^0/, "1");
cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
cert.validity.notAfter = new Date();
cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 5);
const attributes = [
  { name: "commonName", value: "EcoData Root CA" },
  { name: "organizationName", value: "EcoData" },
  { shortName: "OU", value: "Secure Web Optimization" },
  { name: "countryName", value: "MG" },
];
cert.setSubject(attributes);
cert.setIssuer(attributes);
cert.setExtensions([
  { name: "basicConstraints", cA: true, critical: true },
  { name: "keyUsage", keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
  { name: "subjectKeyIdentifier" },
]);
cert.sign(keys.privateKey, forge.md.sha256.create());

fs.writeFileSync(path.join(certsDir, "ca.pem"), forge.pki.certificateToPem(cert), { mode: 0o644 });
fs.writeFileSync(path.join(keysDir, "ca.private.key"), forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
fs.writeFileSync(path.join(keysDir, "ca.public.key"), forge.pki.publicKeyToPem(keys.publicKey), { mode: 0o644 });
console.log(`EcoData Root CA generated in ${outputDir}`);
