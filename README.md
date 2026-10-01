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

What is still missing on the way to a profitable, scalable company (processes,
automation, alerts, finance, compliance) is planned in the app repo:
`CMM/docs/SCALE-PLAN.md`. Many of its items name files in this repo.

## Authentication

`POST /verify/check` returns a JWT after SMS verification. Clients send it as
`Authorization: Bearer <token>` and as `auth.token` in the Socket.IO
handshake. An authenticated request always acts as the phone in its token.

Rollout: while `AUTH_REQUIRED` is not `true`, requests **without** a token are
still accepted (older app versions) and a token-less client may act as any
phone number it claims. Once all clients send tokens, set `AUTH_REQUIRED=true`.
Check the production value with `GET /api/push-health`: `"authRequired":true`
means the flag is on; `false` means set it on Render now. `index.js` logs an
error line at start while it is off. The legacy code paths (`lib/auth.js`,
`socket.js`, `/rtcToken`, `phones` in `/contacts/match`) are removed once
`minBuild` in the app config is at least the first build that sends tokens.

## Who may call whom

`lib/calls.js` startCall refuses a call with reason `not_connected` unless the
two are connected (`lib/relations.js` isConnected): each has the other in
`User.contacts`, or both are members of the same circle. Contacts are the
address book matches from `POST /contacts/match` plus `User.connections`, the
people one got connected with through an invite (`lib/invites.js`); the match
merges the connections back into `contacts` on every sync, so an invited pair
stays connected even when neither has the other's number saved. A block ends a
connection. Refused calls are counted per day (`MetricsDaily.ops.callsRejectedNotConnected`).

Console → App → Flags: `calls_strict_contacts` (default on when unset) switches
the check; `false` lets anyone ring anyone again, for a rollout only.

`POST /contacts/match` is limited to 60 requests per user (token phone,
otherwise IP) per 24 hours; the app syncs at start, after someone joined and
on pull-to-refresh. `lastOnline` is only returned for matches who have the
caller as a contact too (a token-less legacy client therefore sees none). A request with more than 2,000 hashes (or legacy phone numbers) and no match
is logged and counted (`MetricsDaily.ops.matchSuspicious`).

Day counters like these live in `lib/opsCounters.js` (one `OpsTally`
document per day, raised with `$inc`); `lib/metrics.js` copies them into the
day's snapshot under `ops`.

## Health check

`GET /healthz` answers without authentication and without writing anything:

- `200 {ok:true, db:"connected", lastTickAgeSec, version}` when MongoDB is
  connected and the leader finished a background job (`lib/leader.js` stamps
  `lastRunAt` on the `jobs` lock) less than 3 minutes ago. A process younger
  than 5 minutes passes without a tick (`lastTickAgeSec: null`), because the
  first minute tick is still ahead.
- `503 {ok:false, reason}` otherwise: `db` (not connected or the lock could
  not be read), `tick_stale` (last job older than 3 minutes), `no_tick` (no
  job ever finished and the process is older than 5 minutes).

`index.js` also exits the process (code 1, after releasing the `jobs` lease)
on `unhandledRejection` and `uncaughtException`; Render restarts it.

Set up once, by hand (nothing in the repo does this):

- [ ] Render → the service → Settings → Health Check Path: `/healthz`. Render
      then only routes traffic to an instance that answers 200 and restarts
      one that keeps failing.
- [ ] External monitor, free tier of Better Stack or UptimeRobot, one check
      per minute (UptimeRobot free: 5 minutes), alerts to the phone via the
      provider's app or mail:
  - [ ] `https://api.wannayap.app/healthz`, expect HTTP 200
  - [ ] `https://api.wannayap.app/api/push-health`, keyword check: the body
        must contain `"voipConfigured":true` and `"authRequired":true`
  - [ ] `https://wannayap.app`, expect HTTP 200
  - [ ] `https://wannayap.app/.well-known/apple-app-site-association`, expect
        HTTP 200 (Universal Links break silently without it)
- [ ] Phone calls as escalation are not in the free tiers; a paid plan
      (≈ 20–30 $/month) only with an entry in `AppConfig.fixedCosts`
      (`CMM/docs/SCALE-PLAN.md`, 1.2 and 1.10).

## Subscriptions (Wanna yap+)

RevenueCat posts every subscription event to `POST /webhooks/revenuecat`
(`routes/plus.js`). Each event is stored first in `SubscriptionEvent`
(`models/SubscriptionEvent.js`: event id, user, type, product, store,
environment, price in cents, currency, period, expiry, transfer ids, and the
`result` the webhook decided), with the event id unique, so a retry answers
`duplicate` and changes nothing; if applying fails, the stored event is
removed again and the retry applies. The stored rows are the basis for MRR
and churn; the raw payload is not kept. Sandbox purchases (test accounts)
keep Plus for the tester with `plus.source = "sandbox"` and show up
separately in the console, never as paying. A TRANSFER moves Plus from the
old app user to the new one. `User.plus.status` says what the store last
reported (active, trial, cancelled, billing_issue, paused, expired).

`POST /me/plus/sync` (authenticated) asks RevenueCat's REST API for the
caller's subscriptions and sets Plus from the answer, for the moment right
after a purchase or restore when the webhook may still be on its way; it
needs `REVENUECAT_API_KEY`.

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
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | posting | TikTok developer app (Login Kit + Content Posting API); its redirect URI is `https://api.wannayap.app/marketing/tiktok/callback`. Connected in the console (Freigabe → Kanäle) |
| `ADMIN_PUSH_PUBLIC_KEY`, `ADMIN_PUSH_PRIVATE_KEY` | no | VAPID key pair for push to the admin console (`npx web-push generate-vapid-keys`); without them a pair is created once and kept in the database |
| `ADMIN_RP_ID`, `ADMIN_ORIGIN` | no | Passkeys (Face ID) for the console: the host and origin the console runs on, default the host of `PUBLIC_API_URL` and `https://` + that host |
| `ADMIN_PUSH_CONTACT` | no | Contact address sent to the push services, default `hallo@wannayap.app` |
| `REVENUECAT_WEBHOOK_SECRET` | purchases | The Authorization value RevenueCat sends to `POST /webhooks/revenuecat`; without it the webhook refuses everything |
| `REVENUECAT_API_KEY` | no | RevenueCat secret API key (v1) for `GET /v1/subscribers/{id}`: `POST /me/plus/sync` after a purchase in the app, and a TRANSFER whose source we don't know. Without it sync answers 501 and such a transfer grants Plus without end date (logged) |
| `POST_SLOTS` | no | When approved ad videos go out, Europe/Berlin, default `12:00,18:00` (one video per slot) |
| `PORT` | no | Set by Render |
