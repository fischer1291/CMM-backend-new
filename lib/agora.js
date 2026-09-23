const { RtcTokenBuilder, RtcRole } = require("agora-access-token");

// The certificate was committed to this public repo before; it must be rotated
// in the Agora console and provided via AGORA_APP_CERTIFICATE.
const LEGACY_APP_ID = "28a507f76f1a400ba047aa629af4b81d";
const LEGACY_APP_CERTIFICATE = "3fc8e469e8b241d3866c6a77aaec81ec";

function agoraCredentials() {
  const appId = process.env.AGORA_APP_ID || LEGACY_APP_ID;
  const certificate = process.env.AGORA_APP_CERTIFICATE || LEGACY_APP_CERTIFICATE;
  return { appId, certificate, usingLegacyCertificate: !process.env.AGORA_APP_CERTIFICATE };
}

const TOKEN_TTL_SECONDS = 3600;

function buildRtcToken(channelName, account, role) {
  const { appId, certificate } = agoraCredentials();
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  return RtcTokenBuilder.buildTokenWithAccount(
    appId,
    certificate,
    channelName,
    String(account),
    role === "publisher" ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER,
    expiresAt,
  );
}

module.exports = { agoraCredentials, buildRtcToken };
