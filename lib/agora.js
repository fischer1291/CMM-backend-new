const { RtcTokenBuilder, RtcRole } = require("agora-access-token");

// The App ID is public (the app ships it); the certificate only comes from
// the environment. An old certificate that was once committed here has been
// revoked in the Agora console.
const DEFAULT_APP_ID = "28a507f76f1a400ba047aa629af4b81d";

function agoraCredentials() {
  const appId = process.env.AGORA_APP_ID || DEFAULT_APP_ID;
  const certificate = process.env.AGORA_APP_CERTIFICATE || null;
  return { appId, certificate, usingLegacyCertificate: !certificate };
}

const TOKEN_TTL_SECONDS = 3600;

function buildRtcToken(channelName, account, role) {
  const { appId, certificate } = agoraCredentials();
  if (!certificate) throw new Error("AGORA_APP_CERTIFICATE is not set");
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
