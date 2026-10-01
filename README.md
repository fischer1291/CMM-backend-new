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

## Sign-up SMS: cost brakes

Every `POST /verify/start` costs a Twilio Verify SMS. Besides the limiters
per IP (20/h) and per number (5 per 15 min), `routes/verify.js` checks the
`ops` block of the app config (Console → App → Betrieb, `lib/appConfig.js`
DEFAULT_OPS, cached 30 s), in this order:

- `smsPaused` (default off): the kill switch; every start answers 503
  "Die Anmeldung per SMS ist gerade pausiert".
- `smsRegions` (default `DE, AT, CH`): the number's country must be on the
  list, otherwise 403 "Wanna yap? gibt es derzeit nur in Deutschland,
  Österreich und der Schweiz". A number whose country can't be told
  (satellite, other non-geographic ranges) is refused too. Existing
  accounts keep getting their code wherever their number is from: the list
  guards against SMS pumping with new numbers, not against users who moved.
- `smsPerDay` (default 100): a global cap per day (Europe/Berlin). The day's
  counter `smsStarted` is raised with a conditional `$inc`
  (`lib/opsCounters.js` countUpTo), so the check and the booking are one
  step; at the cap every start answers 429 "Heute sind keine Anmeldungen
  mehr möglich" and the server logs a line (once per day). Set the cap to about three
  times the sign-ups you expect per day.

The demo login for App Store review (`REVIEW_PHONE`) sends no SMS and skips
all three. The day's counters `smsStarted`, `smsChecked` (code checks sent
to Twilio) and `smsFailed` (Twilio refused to send) land in
`MetricsDaily.ops`; the daily push and the "Heute" card show
"SMS x/Deckel". Still by hand: Twilio Verify Fraud Guard and an
auto-recharge limit in the Twilio console.

## Invite rewards

`lib/referral.js`: every 3 people who come in through a user's invites
**and have their first talk** (`User.milestones.firstTalkAt`, set by
`noteFirstTalk` from `lib/calls.js` recordTalk and from circle rounds in
`lib/circles.js`) give the inviter 30 days of Wanna yap+, up to 6
times. A join alone (`User.invitesJoined`, badge "Brückenbauer") earns
nothing; `User.invitedBy` remembers who invited the new user, and their
first talk raises `invitesActivated` on each inviter and grants what is due.
`/me/plan` returns `referral: { joined, activated, earned, toNext, ... }`,
`toNext` counted on `activated`.

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

## Backup

`.github/workflows/db-backup.yml` dumps the production database every Sunday
03:17 UTC (and on "Run workflow"): `mongodump --archive --gzip`, encrypted
with [age](https://github.com/FiloSottile/age) against the public key, then
`aws s3 cp` to `s3://<bucket>/mongo/<YYYY-MM-DD>.archive.gz.age` at an
S3-compatible endpoint (Backblaze B2 or Cloudflare R2, free tier). The
newest 8 dumps stay in the bucket, older ones are deleted after each upload.
The plain archive never leaves the runner and is deleted right after
encryption; the run fails with an `::error::` naming the missing secret when
one is not set. GitHub mails the owner when a scheduled run fails; the alert
"last dump older than 8 days" comes with plan 1.10.

GitHub secrets (Settings → Secrets and variables → Actions):

| Secret | Purpose |
|---|---|
| `MONGODB_URI` | Connection string of the production cluster; a user with read access to the database is enough. It must name the database (`…mongodb.net/wannayap?…`), so only that database is dumped and restored, not `admin` and everything else on the cluster |
| `BACKUP_AGE_PUBLIC_KEY` | The public half of the age key pair (`age1…`), from `age-keygen -o backup-key.txt` |
| `BACKUP_S3_ENDPOINT` | `https://s3.<region>.backblazeb2.com` or `https://<account>.r2.cloudflarestorage.com` |
| `BACKUP_S3_BUCKET` | Bucket name (private, no public access) |
| `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` | A key limited to that bucket with read, write and delete |

Atlas → Network Access must allow GitHub-hosted runners, which have no fixed
IPs: either `0.0.0.0/0` (what Render needs anyway unless its static outbound
IPs are listed) or a temporary entry before a manual run. Otherwise
`mongodump` fails with a server selection timeout, not with a clear message;
the secrets check cannot catch this. The schedule runs on `main` only (merge
first; the first Sunday run comes after the merge), and GitHub pauses it after
60 days without a commit, re-enable it under Actions.

The private key (`AGE-SECRET-KEY-1…` in `backup-key.txt`) is never in this
repo and never at GitHub: it lives in the password manager only, with
emergency access for the second owner (plan 1.8). Without it every dump is
noise; with it every dump is plain text.

Restore into a temporary cluster (never into production; the drill with
dates and checks is in the app repo, `CMM/docs/RUNBOOK.md`):

```bash
aws s3 cp --endpoint-url "$BACKUP_S3_ENDPOINT" s3://<bucket>/mongo/<YYYY-MM-DD>.archive.gz.age .
age -d -i backup-key.txt -o dump.archive.gz <YYYY-MM-DD>.archive.gz.age
mongorestore --uri "<temporary cluster>" --archive=dump.archive.gz --gzip --drop
```

Then `TEST_MONGODB_URI="<temporary cluster>" npm test`: the suite runs
against that cluster in a database of its own (`wannayap-test-<pid>`, created
and dropped by the run) and proves that this code version works with it; the
restored data next to it stays untouched. `test/helpers.js` refuses to drop
any database without that prefix.

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
| `TEST_MONGODB_URI` | no | Tests only: `npm test` runs against this cluster (in its own `wannayap-test-<pid>` database) instead of the in-memory MongoDB; used in the restore drill, see Backup |
