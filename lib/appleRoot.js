/**
 * The one certificate App Store Server Notifications are trusted under
 * (plan 2.6b, lib/appleNotifications.js): Apple Root CA - G3, downloaded
 * from https://www.apple.com/certificateauthority/AppleRootCA-G3.cer (DER,
 * converted with `openssl x509 -inform der`) and embedded here, so no
 * request at runtime decides what we trust. The SHA-256 fingerprint below
 * is checked when this file loads: a changed byte stops the start instead
 * of trusting something else. Valid until 2039-04-30. To compare by hand:
 * `openssl x509 -in <file> -noout -fingerprint -sha256` against the
 * fingerprint Apple lists on https://www.apple.com/certificateauthority/.
 */
const { X509Certificate } = require("crypto");

const APPLE_ROOT_CA_G3_PEM = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----
`;

const APPLE_ROOT_CA_G3_SHA256 = "63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79";

const appleRootCaG3 = new X509Certificate(APPLE_ROOT_CA_G3_PEM);
if (appleRootCaG3.fingerprint256 !== APPLE_ROOT_CA_G3_SHA256) {
  throw new Error("lib/appleRoot.js: the embedded Apple Root CA - G3 does not match its SHA-256 fingerprint");
}

module.exports = { appleRootCaG3, APPLE_ROOT_CA_G3_PEM, APPLE_ROOT_CA_G3_SHA256 };
