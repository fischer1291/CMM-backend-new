# Wanna yap? – Backend

Express + Socket.IO + MongoDB backend for the Wanna yap? app. Deployed on
Render from `main`.

```bash
npm install
npm test        # API + socket tests against an in-memory MongoDB
npm start       # needs the environment below
```

## Structure

| File | Contents |
|---|---|
| `index.js` | Startup: DB connection, migrations, periodic jobs |
| `app.js` | Express app, middleware, token/upload endpoints |
| `socket.js` | Call signaling (Socket.IO) |
| `routes/` | REST routes |
| `lib/auth.js` | JWT auth for HTTP and sockets |
| `lib/phone.js` | E.164 phone normalization |
| `lib/push.js` | Expo and VoIP (APNs) push |
| `lib/agora.js` | Agora RTC tokens |

## Authentication

`POST /verify/check` returns a JWT after SMS verification. Clients send it as
`Authorization: Bearer <token>` and as `auth.token` in the Socket.IO
handshake. An authenticated request always acts as the phone in its token.

Rollout: while `AUTH_REQUIRED` is not `true`, requests **without** a token are
still accepted (older app versions). Once all clients send tokens, set
`AUTH_REQUIRED=true`.

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `MONGODB_URI` | yes | MongoDB connection |
| `JWT_SECRET` | yes | Signs auth tokens; without it no tokens are issued |
| `AUTH_REQUIRED` | later | `true` rejects requests without a token |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SID` | yes | SMS verification |
| `AGORA_APP_ID`, `AGORA_APP_CERTIFICATE` | yes | Agora tokens (the old certificate was public and must be rotated) |
| `VOIP_KEY_CONTENT`, `VOIP_KEY_ID`, `VOIP_TEAM_ID` | iOS | APNs key for VoIP pushes |
| `VOIP_TOPIC` | no | Defaults to `com.schly21.kontaktlisteapp.voip` |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | yes | Avatar uploads |
| `EXPO_ACCESS_TOKEN` | no | Expo push |
| `SMTP_URL` | waitlist | SMTP for waitlist mails, e.g. `smtps://user:pass@smtp-relay.brevo.com:465`; without it no mail is sent |
| `MAIL_FROM` | no | Sender, defaults to `Wanna yap? <hallo@wannayap.app>` (the domain needs SPF/DKIM at the mail provider) |
| `SITE_URL`, `PUBLIC_API_URL` | no | Links in mails, default `https://wannayap.app` and `https://api.wannayap.app` |
| `WAITLIST_BATCH` | no | Launch mails per 15 s batch (default 40, max 200); keep under the provider's rate limit |
| `MARKETING_AGENT_KEY` | agent | Bearer key of the daily marketing agent (CMM repo, `marketing/AGENT.md`), at least 24 characters; without it `/marketing/*` refuses everyone |
| `PORT` | no | Set by Render |
