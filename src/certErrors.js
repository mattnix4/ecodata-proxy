const CERT_ERROR_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_HAS_EXPIRED",
]);

const CERT_ERROR_MESSAGES = [
  "unable to verify the first certificate",
  "unable to get local issuer certificate",
  "unable to get issuer certificate",
  "self signed certificate",
  "self-signed certificate",
  "certificate has expired",
];

function isCertificateError(err) {
  if (!err) return false;
  if (CERT_ERROR_CODES.has(err.code)) return true;
  const message = String(err.message || err).toLowerCase();
  return CERT_ERROR_MESSAGES.some((pattern) => message.includes(pattern));
}

module.exports = { isCertificateError };
