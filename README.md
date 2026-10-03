# Wanna yap? – Backend

Express + Socket.IO + MongoDB backend for the Wanna yap? app. Deployed on
Render from `main`.

Node 22 (see `.nvmrc`; `engines` in `package.json` pins `22.x`, CI runs the
same version). Render reads `engines` too; set `NODE_VERSION=22` in the
service's environment so a change of the Render default never surprises us.

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
| `lib/acquisition.js` | "Woher kennst du Wanna yap?" (`User.acquisition`) and the campaigns with their numbers per slug, see Acquisition and campaigns |
| `lib/devices.js` | Device list (`User.devices`, `X-Device-Id`/`X-Device-Model`), see Recycled numbers and devices |
| `lib/economics.js` | Unit economics: costs, contribution, break-even, runway (`GET /admin/economics`), see Unit economics |
| `lib/lifecycle.js` | Lifecycle pushes: onboarding days 1/3/7, inactivity, weekly series, Plus ending, billing, win-back (leader job every 30 min), see Lifecycle pushes |
| `lib/pseudonyms.js` | Keyed phone pseudonyms (`User.phoneHmac`) and their one-off migration, see Pseudonymous data |
| `lib/sentry.js` | Error tracking: Sentry init, scrubbing, crash reports, see Error tracking (Sentry) |
| `lib/weeklyReport.js` | The weekly report: the last full week from `MetricsDaily`, mail and push on Monday from 08:00 (leader job every 15 min), see Weekly report |
| `routes/verify.js` | SMS sign-in, the review login, "Ist das dein Konto?" for recycled numbers (`/verify/account-check`) |
| `routes/adminCampaigns.js` | Console tab Kampagnen: campaigns, numbers per slug, QR (`/admin/campaigns`) |
| `routes/adminWeekly.js` | Console tab Woche: the weekly report and its review with the hours of operations (`/admin/weekly`, `/admin/weekly/ack`) |
| `routes/webhooks.js` | Webhooks signed over the raw body: `POST /webhooks/sentry` → alert `sentry_fatal` |
| `COMPLIANCE.md` | Record of processing per collection, processors, the privacy change process; `test/compliance.test.js` fails when a model has no row |

What is still missing on the way to a profitable, scalable company (processes,
automation, alerts, finance, compliance) is planned in the app repo:
`CMM/docs/SCALE-PLAN.md`. Many of its items name files in this repo.

## Authentication

`POST /verify/check` returns a JWT after SMS verification. Clients send it as
`Authorization: Bearer <token>` and as `auth.token` in the Socket.IO
handshake. An authenticated request always acts as the phone in its token.
The app sends `ageConfirmed` (true), `termsVersion` and `privacyVersion`
(each up to 40 characters, `TERMS_VERSION` and `PRIVACY_UPDATED` from the
app's `content/legal.ts`) with `/verify/check` once the person ticked the
age box in onboarding; the backend stores them as `User.consent`
(`ageConfirmedAt`, `termsVersion`, `privacyVersion`), again when a version
changes, and never refuses a sign-in without them (older apps). `GET /me`
and the export return `consent`.

Rollout: while `AUTH_REQUIRED` is not `true`, requests **without** a token are
still accepted (older app versions) and a token-less client may act as any
phone number it claims. Once all clients send tokens, set `AUTH_REQUIRED=true`.
Check the production value with `GET /api/push-health`: `"authRequired":true`
means the flag is on; `false` means set it on Render now. `index.js` logs an
error line at start while it is off. The legacy code paths (`lib/auth.js`,
`socket.js`, `/rtcToken`, `phones` in `/contacts/match`) are removed once
`minBuild` in the app config is at least the first build that sends tokens.

## Recycled numbers and devices

Plan 2.9. Prepaid numbers go back to the carrier and on to someone else;
before, the new holder's first sign-in opened the old account.

**Devices.** The app sends `X-Device-Id` (the iOS identifierForVendor, or a
UUID it made once and keeps in SecureStore; `[A-Za-z0-9-]`, at most 64,
never an advertising id) and `X-Device-Model` (expo-device `modelName`, cut
to 40) with every request. `User.devices` keeps `{ id, model, platform,
appVersion, appBuild, firstSeenAt, lastSeenAt }` for at most ten devices
(the least recently seen fall out, `lib/devices.js`), written by
`/verify/check`, `/verify/account-check`, `/user/push-token` (which also
stores the id as `pushTokenMetadata.deviceId`) and, at most every six hours
per device and instance, by any authenticated request (`lib/auth.js`, next
to the app version). `User.lastVerifiedAt` is the last verification that
issued a token. `GET /me/devices` lists them, most recent first, `current`
marking the caller.

**"Ist das dein Konto?"** `/verify/check` holds the token back when the
account behind the number has been quiet for `RECYCLE_AFTER_DAYS` = 180
days (an assumption; the latest `ActiveDay` under every key of the number,
else `lastOnline`, else `milestones.verifiedAt`, else the account's
creation; not the newest of all, because the schedule job and moderation
write `lastOnline` without the person),
the sign-in comes from a device not in `User.devices`, and the account has
a name or a picture. It answers `200 { success: true, phone, accountCheck:
{ name (first name only), avatarUrl, lastActiveMonth: "YYYY-MM" }, checkToken
}`. The `checkToken` is an HMAC-SHA256 with `JWT_SECRET` over
`phone|nonce|until`, valid ten minutes, once: the nonce sits in
`User.accountCheck` and is cleared on redemption (a newer question replaces
an older one). `POST /verify/account-check { phone, checkToken, answer:
"mine" | "not_mine" }` (consent fields and `inviteCode` may ride along as
with `/check`): `mine` signs in like `/check`; `not_mine` stores the old
account's export as `ArchivedAccount` (30 days TTL, for support only: when
someone chose it by mistake, support rebuilds the account from the export
by hand; the avatar and moment images at Cloudinary and the RevenueCat
subscriber are gone with the deletion, a store subscription comes back
through "Käufe wiederherstellen", other Plus sources by hand), deletes it with `lib/account.js deleteAccount` (other people's
contacts lose the number), creates a fresh account whose
`tokensValidAfter` cuts off every token from the old holder's time, and
signs in. An expired, used or foreign `checkToken` gets `401 { error:
"check_expired" }`; the app starts over with a new SMS. Not asked: the
review login (`REVIEW_PHONE`), accounts without name and picture, and
everyone in legacy mode (no `JWT_SECRET`), and apps from before plan 2.9
(no `X-Device-Id`): they cannot show the question and sign in as before,
counted as `accountCheckNoDevice`. So there is no deploy order between
backend and app, and a returning owner on an old app is never locked out;
the new holder of a recycled number installs the current app, which sends
the id, and once `minBuild` is at a build that sends it, old apps stop at
the update screen anyway. Day counters (`MetricsDaily.ops`):
`accountCheckAsked`, `accountCheckNoDevice`, `accountCheckMine`,
`accountCheckNotMine`, `logoutAll`.

**New device push.** When a device that sends `X-Device-Id` and is not in
`User.devices` signs in, and the account's push token belongs to another
device of the list (`pushTokenMetadata.deviceId` is listed there and
differs), that token gets `new_device` ("Neue Anmeldung", deep link
`/settings`) before the new device is stored: no switch, not social, silent
at night like `missed_call`. Quiet when it is unclear whose the token is:
sign-ins without `X-Device-Id`, accounts without a device list yet, and
tokens still registered with the old body `deviceId` (until the updated
app sends `/user/push-token` again), so the phone that signs in is never
warned about itself.

**Überall abmelden.** `POST /me/logout-all { pushToken?, voipToken? }` (token
only) ends every session with `lib/moderation.js endSessions`
(`tokensValidAfter`, the access cache, open sockets, the caller's too),
removes push and VoIP tokens unless they equal the ones sent (the caller's
own), keeps only the calling device in `User.devices`, and answers `{
success: true, token }` with a fresh token for the caller, issued one second
after the cut-off (tokens carry whole seconds; `lib/accessGate.js` refuses
the cut-off's own second). JWT rotation with a key list stays a step of its
own.

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

A ring ends after 45 seconds (`RING_TIMEOUT_MS`): a process timer does it
in time, and the deadline is also stored as `Call.ringUntil`, so the leader's
minute tick (`sweepStaleCalls`, also run at start) ends every ring a deploy or
crash left behind exactly like the timer would, with `callEnded` (reason
`missed`) to both sides and the missed-call push. The same sweep ends an
accepted call nobody hung up after two hours and records it as a talk capped
at that length; on start, the talk replay only looks at calls ended since the
latest recorded talk.

`POST /contacts/match` is limited to 60 requests per user (token phone,
otherwise IP) per 24 hours; the app syncs at start, after someone joined and
on pull-to-refresh. `lastOnline` is only returned for matches who have the
caller as a contact too (a token-less legacy client therefore sees none). A request with more than 2,000 hashes (or legacy phone numbers) and no match
is logged and counted (`MetricsDaily.ops.matchSuspicious`).

Day counters like these live in `lib/opsCounters.js` (one `OpsTally`
document per day, raised with `$inc`); `lib/metrics.js` copies them into the
day's snapshot under `ops`. The five counters behind the outage banner
(`RECENT`: `smsStarted`, `smsFailed`, `pushCredentialErrors`,
`rtcTokenIssued`, `rtcTokenFailed`) are also kept per UTC hour
(`opsh:YYYY-MM-DDTHH`, TTL two days via `expiresAt`), see Outage banner.

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
all three. It ends with the day `REVIEW_UNTIL` (`YYYY-MM-DD`, Europe/Berlin;
`/api/push-health` then says `reviewLogin: "expired"` and the number gets an
ordinary SMS); without `REVIEW_UNTIL` it stays on and the alert
`review_login` asks for an end date, after it for removing the variables. The day's counters `smsStarted`, `smsChecked` (code checks sent
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

**Gift budget (plan 2.12).** Every Plus day given as a present is booked
as a day counter (`lib/opsCounters.js`, `lib/referral.js` `countGiftDays`):
`giftDays_referral` (the ladder above and the two-sided experiment),
`giftDays_waitlist` (`lib/waitlist.js` redeem) and `giftDays_admin`
(`POST /admin/users/:id/plus` with `days`; a grant without end, for testers
and the team, and a revoke count nothing). The snapshot copies them into
`MetricsDaily.plus.giftDaysGranted { referral, waitlist, admin }`, the Plus
tab shows the last 7 days ("Geschenk-Tage 7 Tage"), the metrics CSV has
them as `geschenk_tage_*`. The alert `gift_days` fires when the sum of the
last 7 days (today and the six days before) is over
`AppConfig.goals.giftDaysPerWeek` (Console → App → Ziele, default 200, an
assumption: gift Plus should stay under 20 % of the MRR). Gift to store:
`MetricsDaily.plus.giftToStore` counts the day's production
INITIAL_PURCHASE (a trial start included) of people whose Plus was a gift
before. The source before the store is kept in `User.plus.previousSource`
when the source switches to `store`/`sandbox` (webhook, TRANSFER, sync and
nightly reconcile, `lib/plusReconcile.js` `previousSourceFor`), so it
survives whichever of webhook and sync comes first; an expired gift still
counts as the gift before. Approximation: someone whose store plan lapsed
and who buys again with a new INITIAL_PURCHASE counts again. Gifts never
touch Plus from the store (also `sandbox`) or an admin grant without end.

**Two-sided experiment (flag `referral_two_sided`, off by default).** With
the flag on (Console → App → Feature-Flags: add `referral_two_sided`, tick
"an"), an invitee and their inviter each get 7 days of Plus (`referral`,
on top of a running gift, booked as `giftDays_referral`) after their first
1:1 talk of at least 60 seconds (`lib/calls.js` recordTalk →
`lib/referral.js` `rewardPair`). "First" is literal: a pair that already
had such a talk, also from before the flag, gets nothing. Once per pair:
the inviter's number goes into the invitee's `User.referralPairRewards` by
a conditional update (removed when the inviter deletes the account). Both
get the push `referral_pair_reward` (opens `/plus`), someone with a store
plan or an open admin grant keeps it and gets neither days nor push. The
ladder above runs on as before. `/me/plan` adds `referral.twoSided`
(boolean, the flag) and `referral.pairDays` (7) for the app's card. Judge it
by gift days per week and gift to store, against the self-referral
suspicion (invitees without a talk) under 10 % (assumptions, plan 2.12).

## Invite links

Every account has a personal invite code (`User.inviteCode`, 8 characters
from the waitlist code alphabet, unique). `POST /verify/check` gives it on
sign-up; accounts from before get theirs on their next own `GET /me`
(`lib/invites.js` ensureInviteCode), and `GET /me` returns it as
`inviteCode` (own profile only). The app shares `/einladung?von=CODE`.

- `POST /invites/visit { code, platform: "ios" | "android" | "other" }`
  (public, 60/h per IP): the page was opened. A counter per day, code and
  platform (`InviteVisit`, TTL 400 days), nothing about the visitor. Answers
  `{ success: true, valid }`; unknown codes count too with `valid: false`.
- `POST /verify/check { ..., inviteCode? }`: the link opened the app and the
  sign-up carries the code. If the person has no inviter yet and the code
  belongs to someone else, both are connected like an invite
  (`contacts`, `connections`, `invitedBy`, `joinedViaInvite`, the inviter's
  `invitesJoined`, `claimInviteCode`); the own code and unknown codes are
  ignored in silence, the answer is unchanged.
- `POST /waitlist { ..., platform? }`: Android visitors of the invite page
  join the waitlist with `platform: "android"`, `source: "einladung"` and
  `campaign: "invite-CODE"`. Without `platform` the user agent decides
  (iPhone/iPad → `ios`, Android → `android`, else null); stored as
  `WaitlistEntry.platform`.
- `User.locale`: the first entry of `Accept-Language` (e.g. `de-DE`, up to
  20 characters), stored by `/verify/check` and `/me/update`. Measured only.

The daily snapshot (`lib/metrics.js` computeDay) carries
`growth.inviteVisits { total, ios, android, other }`,
`waitlist.byPlatform { ios, android, unknown }` (confirmations of the day)
and `users.byLocale` (the five most common locales of the day's sign-ups).

## Yap Moment

Once a day, at a random time between 10:00 and 21:00 per time zone, everyone
in the zone gets the `daily_moment` push and has ten minutes
(`lib/dailyMoment.js`; the leader's minute tick starts it, `DailyMoment`
holds one document per day and zone, Europe/Berlin first).

- `GET /daily` (token): `{ success, active, nextAt, nextEndsAt }`, while it
  runs also `startedAt`, `endsAt`, `joined` (am I in) and `participants`
  (contacts who joined and are still available). Since plan 2.13 `nextAt`
  and `nextEndsAt` (ISO or null) are today's start and end in the caller's
  zone (`User.timezone`, else Europe/Berlin) while the moment is still ahead,
  for the countdown on the home screen ("Beim Yap Moment treffen"); null
  once it runs (then `active` is true), once it is over, and on a day whose
  moment was created after 21:00 (it never fires). The route creates the
  day's moment with `momentFor` when the minute tick has not done it yet, so
  the time is fixed from the first request on.
- `POST /daily/join { mood? }` (token): available until the end plus five
  minutes; 409 `not_active` outside the window.

## Re-match

Plan 2.13, `lib/rematch.js`: "Sag mir, wenn jemand aus meinem Adressbuch
dazukommt". The invite tells the inviter when the invited person joins
(`contact_joined`); re-match does the same for people who never sent an
invite but have the number in their address book, and only when they asked
for it.

- `PUT /me/rematch { optIn: boolean }` (token, 401 without; anything but a
  boolean is 400 `invalid_optIn`) answers `{ success: true, optIn }` and
  stores `User.rematch { optIn, at }` (default off). Off deletes the stored
  list at once. `GET /me` (own profile) returns `rematchOptIn`. The app
  syncs the contacts right after switching it on, so the list exists.
- `POST /contacts/match` with `hashes` (the SHA-256 variant only, never the
  legacy `phones`): for a caller with the opt-in, the hashes that matched no
  account (users, blocked users and the own number are left out) replace
  the caller's `AddressBookHash` document: one per person, each entry
  HMAC-SHA256 with the pepper of `User.hmacPhone` over the SHA-256 hex the
  app sent (never the hash itself), deduplicated, at most 5,000,
  `expiresAt` 90 days after the sync (TTL index). A request that looks like
  a scan (over 2,000 hashes without a match, `matchSuspicious`) is never
  kept: the push would tell a scanner when any of those numbers joins. A
  sync where every entry is a user leaves no document. A failure is logged
  and never fails the match.
- A new user sets a name (`POST /me/update`, `lib/invites.js`
  announceJoined, the same moment the inviters hear it): every owner whose
  list holds the user's entry loses it by a conditional `$pull` (so two
  parallel updates never push twice), and those that still have the opt-in,
  are not blocked either way and are not among the user's inviters
  (`invitedBy`, `connections`, `pendingJoinAnnouncement`: they get
  `contact_joined` from the invite) get the socket event `contactJoined
  { phone, name, via: "address_book" }` and the push `contact_joined` (the
  usual type, social cap and quiet hours; the body says "Die Nummer ist in
  deinem Adressbuch …" in place of the invite text; deep link
  `/friend?phone=…`). A user who never sets a name tells nobody; the next
  sync of the owners finds them as a user anyway.
- Deletion (`lib/account.js`): the own list, and the own entry in other
  lists. Export (`GET /me/export`): `rematch { optIn, at, storedHashes,
  updatedAt, expiresAt }`, the number of entries, never the entries.
  `COMPLIANCE.md` has the row `AddressBookHash` and `User.rematch`.
- A new pepper (README "Pseudonymous data") makes the stored entries
  unreachable; every owner's next sync replaces them, the rest expire with
  the TTL. No migration needed.

Before optimizing the conversion around the first talk, look at the limit
hits of the free plan (`MetricsDaily.plus.limitHits`, plan 2.6a, see
"Paywall funnel, limit hits, trials"): a full circle (`circleMembers`, 12)
or the round time (`roomMinutes`, 60) may slow invites down more than the
product does.

## Acquisition and campaigns

Plan 2.10, `lib/acquisition.js`: first-party attribution from the sign-up
to the activated user, without a tracking SDK and without the ATT prompt.

**The question in onboarding.** `POST /me/acquisition { source,
androidFriends? }` (token only) stores "Woher kennst du Wanna yap?" as
`User.acquisition`: `source` is one of `friend | tiktok | instagram | flyer
| press | other`, `androidFriends` how many of the five closest friends
have Android (integer 0–5, or null when skipped); anything else is 400
(`invalid_source`, `invalid_android_friends`). The answer is voluntary.
The server adds `code` (the `inviteCode` of the first inviter,
`invitedBy[0]`, when the account joined through an invite) and `campaign`
(see below); both are never taken from the body. `at` is the first answer:
a second answer within 24 hours replaces the whole answer (a slip in
onboarding) and keeps `at`, after that 409 `already_answered`. Answer
`{ success: true, acquisition: { source, androidFriends, campaign, code,
at } }`. The own `GET /me` carries `acquisition` (null before an answer)
and `joinedViaInvite`, so the app preselects "Über Freund·in" and asks only
once. The data export has `acquisition`; it goes with the account.

**Why the app cannot send the campaign.** A `/k/<slug>` link goes through
the download page to the App Store with Apple's campaign token `ct`; Apple
reports it in App Store Connect (App Analytics → Campaigns), never to us,
and without a tracking SDK there is no deferred deep link that would carry
the slug through the install. So `acquisition.campaign` is set only where
the server knows a campaign itself:

1. the redeemed waitlist entry: its `campaign` (the landing page's
   `utm_campaign`), lowercased, when it is a valid slug and not an invite
   link (`invite-CODE`); a code redeemed after the answer fills an empty
   `campaign` then (`lib/waitlist.js` redeem);
2. the seed campaign, `AppConfig.goals.seedCampaign` (a registered slug or
   null, set in the Kampagnen tab, audited as `config_changed`): while that
   campaign runs (`status: running`, started, not ended) an answer that
   fits its channel counts for it: tiktok → TikTok, instagram → Instagram,
   flyer → Flyer, campus → Freund·in and Flyer, creator → TikTok and
   Instagram, press → Presse, other → Sonstiges. An ASSUMPTION, not a
   measurement; there is only ever one.

Everything else stays null and is counted under its source only.

**Campaigns.** `models/Campaign.js`: `slug` (unique, `[a-z0-9-]{2,40}`, the
name in every link, fixed once created), `channel` (`tiktok | instagram |
flyer | campus | creator | press | other`), `title` (≤ 80), `startedAt`,
`endedAt`, `budgetEurCents` (integer ≥ 0 or null), `partner` (≤ 80),
`status` (`planned | running | ended`, set by hand), `notes` (≤ 1000),
`createdBy`, `createdAt`, `updatedAt`. Routes (`routes/adminCampaigns.js`):

- `GET /admin/campaigns` (viewer): `{ days: 90, seedCampaign, campaigns:
  [{ ...campaign, links: { store, landing }, numbers: { visits,
  storeClicks, waitlist, users, activatedD7, spendEurCents } }],
  unregistered: [{ slug, visits, waitlist, users }] }`, running campaigns
  first. Numbers of the last 90 days: `visits` and `storeClicks` from
  `LandingVisit.campaign`, `waitlist` from confirmed `WaitlistEntry`
  (campaign lowercased), `users` the accounts created in that time with
  that `acquisition.campaign`, `activatedD7` those of them with
  `milestones.firstTalkAt` within 7 days of signing up, `spendEurCents` the
  marketing agent's `MarketingSpend` with that campaign (settled: the cost,
  reserved: the estimate, released: nothing). `unregistered` lists slugs
  seen in those sources that nobody registered (typos, links that went out
  without a campaign), at most 50; invite links and the agent's own video
  campaigns (`AdDraft`, tab Freigabe) are left out.
- `POST /admin/campaigns` (owner, audited `campaign_created`) and
  `PUT /admin/campaigns/:slug` (owner, `campaign_updated`, partial, the
  slug stays: 400 `slug_fixed`): 400 `invalid_slug | invalid_channel |
  invalid_title | invalid_partner | invalid_notes | invalid_dates |
  invalid_budget | invalid_status`, 409 `slug_taken`, 404
  `campaign_not_found`. Dates as `YYYY-MM-DD` or ISO, the end not before
  the start.
- `GET /admin/campaigns/:slug/qr.svg` (viewer): the QR code of
  `SITE_URL/k/<slug>` as SVG (package `qrcode`, already there for the
  console's TOTP setup), for flyers and posters.

The console's tab "Kampagnen" lists them with their numbers, has the form
(owners), the link generator (store link `https://wannayap.app/k/<slug>`,
landing link `https://wannayap.app/?utm_source=<channel>&utm_campaign=<slug>`,
QR as SVG to download) and the section "Nicht angelegte Kurznamen" with a
button to register one. Downloads per campaign stay in App Store Connect.

**Numbers.** The daily snapshot (`lib/metrics.js` computeDay,
METRICS_VERSION 7) carries `growth.bySource { friend, tiktok, instagram,
flyer, press, other, none }` (the day's sign-ups by answer; none: no
answer, a recount before the day is final picks up answers given later),
`growth.byCampaign { <slug>: { new } }` and `growth.androidFriendsAvg` (mean
of the day's answers, null without one); the metrics CSV has them as
`herkunft_*` and `android_freunde_mittel`. `GET /admin/metrics/acquisition
?weeks=4` (viewer, 1–12 weeks) returns `{ weeks, from, to, minSample: 50,
bySource: { <source>: { size, measured, activated, pct } }, last30: {
total, answered, bySource, androidFriendsAvg, androidFriendsAnswers } }`:
activation within 7 days per answer over the last full weeks, only people
whose 7 days are over (`measured`), and the last 30 days of sign-ups. The
dashboard card "Herkunft" shows both; under 50 measured per source it says
"zu wenig Daten" (the plan's goal: over 70 % of new people answer).

## Marketing agent: performance, bio link, failed runs

Plan 2.14 closes the loop between what the daily marketing agent (CMM
repo, `marketing/agent`) posts and what it learns from.

**Post numbers.** A leader job (`post-stats`, `index.js`, checked every 30
minutes, `lib/socialPosting.js` statsDue) claims a reading at most every 6
hours over `MarketingTally` `runs.lastStatsAt`, so deploys and restarts
never postpone it, and reads the numbers of every video posted through the API in the last 30
days (`lib/socialPosting.js` fetchStats) into `AdDraft.stats`: Instagram
`GET /{media-id}/insights?metric=views,reach,likes,shares,saved,comments`
(Instagram replaced the Reels metric `plays` with `views` in 2025; an older
API version that refuses `views` is asked again with `plays`; stored as
`stats.instagram.plays` either way), TikTok `POST /v2/video/query/` with
`view_count,like_count,comment_count,share_count` (`stats.tiktok.views`
…). Each block carries `at`, null until the first reading. Videos posted by
hand (no platform id) and TikTok posts still in the inbox or private (only a
publish id) stay without numbers. A failure is logged per video (TikTok per
batch of 20) and the rest goes on; posting never waits for it. **TikTok
needs the scope `video.list`**, which the login asks for since plan 2.14:
a channel connected before has to be connected once more (Console →
Freigabe → Einstellungen → Kanäle → Trennen, Mit TikTok verbinden), until
then the TikTok numbers stay empty and the log says `scope_not_authorized`.
**Instagram needs the permission `instagram_business_manage_insights`**:
the token from the Meta app dashboard (CMM `marketing/AGENT.md`) has to be
generated once more with it next to `instagram_business_basic` and
`instagram_business_content_publish` and pasted again (Console → Freigabe →
Einstellungen → Kanäle). When no video of a channel can be read, the
channel's `lastError` in the console says why (`Zahlen: …`, with the
missing permission or scope named); the next good reading clears it, and it
never writes over a token or connection error. TikTok token refreshes run
one at a time per process (posting, the token job and the reading share
one), so a refresh token is never spent twice.

**Back into the agent.** `GET /marketing/context` carries, next to the
drafts (each with `hookVariants` and `stats`), `performance { top, flop }`:
up to 10 videos each, posted in the last 30 days, ranked by `viewsPerEur`
(`views` = Instagram plays + TikTok views over `costEur` = the
`MarketingSpend` booked under its campaign, settled at cost, reserved at
the estimate, or the draft's own `costEur` when none was booked; with
fewer than 20 measured the two split the list), each with `campaign,
title, template, kind, postedAt, views, likes, shares, costEur,
viewsPerEur, newUsers, activatedD7` (the campaign tab's numbers for the
slug, `lib/acquisition.js` peopleBySlug, for every slug, registered or
not); `aiCostPerPostedVideoEur` (all `MarketingSpend` of 30 days over the
videos posted on at least one platform in that time, null while none
was); `bioLink`; and `runs { lastRunAt, lastOkAt, lastFailedAt, lastStep,
lastDurationSec }`. Only videos with views and a cost are ranked.
`POST /marketing/drafts` takes `hookVariants` (an array of strings: each
trimmed and cut to 120 characters, empty ones dropped, the first two kept,
because the video is already rendered when the draft arrives; only a wrong
type, no array or an entry that is no string, is `400
invalid_hook_variants`), shown in the console on the draft. No higher AI budget before this loop has run for
a few weeks (the budget card says so).

**Bio link per week.** A leader job (`bio-link`, hourly and at start)
registers the campaign `bio-<year>-w<week>` (ISO week, Europe/Berlin, e.g.
`bio-2026-w41`) once per week: channel `other`, title "Bio-Link KW 41",
status `running` from Monday 00:00 for 7 days, `createdBy: automatisch`;
earlier bio weeks that ran out are set to `ended`. Idempotent over the slug;
a campaign the owner already changed is left alone. The link is
`https://wannayap.app/k/bio-<year>-w<week>` (`SITE_URL`); the console
shows it to copy (Freigabe → Freigegeben and Gepostet), and the owner puts
it into the Instagram and TikTok bio on Mondays, so the campaign tab counts
the bio per week.

**Every run reports.** `POST /marketing/notify` (agent key) `{ failed?,
step?, runUrl?, durationSec? }` at the end of every run: without `failed`
as before (push and mail to the owners when drafts wait, `{ pending, mailed
}`) plus `runs.lastOkAt`; with `failed: true` (the workflow's `if:
failure()` step) `runs.lastFailedAt` and `lastStep` and the alert
`agent_failed` (`{ alerted }`), whose text names the step and the run link
but never an error message (the log stays in GitHub). Lenient on purpose:
a `step` keeps only letters, digits and `._:/()-` (at most 60 characters), a
`runUrl` counts only as https on github.com, `durationSec` only as a number
from 0 to 86400; anything else is left out instead of refusing the report.
Every run raises the day counter `agentRunsOk` or `agentRunsFailed`
(MetricsDaily `ops.*`). `GET /admin/marketing/agent` (viewer) gives the
console `{ bioLink, bioSlug, bioWeek, runs (plus lastRunUrl),
aiCostPerPostedVideoEur, lastStatsAt }`. The rule `agent_silent` (no draft for 36 hours)
stays: it also catches a schedule GitHub paused, where nothing reports.

## User research

Once someone has two talks (`Talk` documents counted like `lib/stats.js`
does: 1:1 talks with them, group rounds only their own record; checked in
`lib/calls.js` recordTalk, so a replayed call counts once and someone who
was active before this existed is asked on their next 1:1 talk) the server
sets `User.research.invitedAt`, and the app shows a card: 15 minutes with
the founder, 7 days of Wanna yap+ as a thank-you. People whose Plus is an
admin grant are not asked. `GET /me` (own profile only) returns
`research: { invitedAt, bookedAt, dismissedAt, doneAt }`;
`POST /me/research { action: "booked" | "dismissed" }` records the answer
once (409 `not_invited` before the invitation) and the card stays away
either way. `POST /admin/users/:id/research-done` (support, audited as
`research_done`) marks the talk as held; the thank-you is the usual
`POST /admin/users/:id/plus { days: 7 }`. `GET /admin/users/:id` carries
`research` once invited; the console page shows no research row or button
yet, so until it does the call is made against the API. The data export
(`GET /me/export`) includes `research`. Guide, notes and the weekly target:
`CMM/docs/RESEARCH.md`.

## Onboarding milestones and the north star

`User.milestones` records when each person reached a step of the funnel,
every field set once by a conditional update and never overwritten:
`verifiedAt` (`POST /verify/check`; accounts from before get it on their
next sign-in), `contactsSyncedAt` and `firstRegisteredContactAt`
(`POST /contacts/match`, the latter only when at least one number was
registered), `pushGrantedAt` (`POST /user/push-token`), `firstCallAt`
(`lib/calls.js` startCall, the caller, only once the call actually rang,
not for an unreachable callee) and `firstTalkAt` (see Invite rewards).
`firstInviteAt` sits on the user directly. No new data leaves the server:
the fields only say when, and the person sees them in their own export
(`GET /me/export`, `milestones`).

`lib/metrics.js` turns them into two rolling numbers in every day's
snapshot (`MetricsDaily.users`):

- `activation4w` (percent) and `activationSample`: of everyone who signed
  up in the last four full weeks (Monday to Sunday, Europe/Berlin), the
  share with a real conversation within 7 days, counted on those whose
  window is over. Under 100 measured the console and the push show the
  number but say "zu wenig Daten" instead of judging it.
- `density: { c3plus, c0, sample }`: of everyone 7 to 35 days in, the
  share (percent) with at least three registered contacts and the share
  with none.

The goals they are judged against live in the app config
(Console → App → Ziele, `AppConfig.goals`, `lib/appConfig.js`
DEFAULT_GOALS): `activationPct` (default 40) and `densityPct` (default 50),
whole percentages, and `giftDaysPerWeek` (default 200, an assumption, 1 to
100,000; the gift budget, see Invite rewards), `seedSignupsPerWeek`
(default 30, an assumption, 1 to 100,000; the seed cluster's sign-ups per
week, see Weekly report), never sent to the app. The "Heute" card shows both
numbers with a traffic light, the Marketing-Budget card (Freigabe) turns red
with "Keine bezahlte Reichweite unter 40 %" while activation is under goal
on a sample of at least 100, and `GET /marketing/context` gives the agent
`activation: { pct4w, sample, goalPct, density, densityGoalPct }` and the
owner's `notes` from the weekly review (`AppConfig.marketingNotes`, null
without; see Weekly report).

The daily push to the console is a morning push: `Admin.notify.dailyHour`
defaults to 8 (the first start after this change moves admins still on the
old default 20 to 8, once, noted in `AppConfig.migrations.morningPush`;
a later, deliberate 20 stays). It reports yesterday whole (`lib/today.js`
yesterdayNumbers): new users, active, talks, visits, waitlist, then
"Aktivierung 4 W: xx % (Ziel 40) 🟢/🔴", "Dichte: xx %", tickets whose
last message is from the user and older than 24 hours, videos waiting for
approval, the tags of the alerts of the last 12 hours ("Alarme der Nacht",
see Alerts) and yesterday's SMS against the cap.

## Lifecycle pushes

After the sign-up something happens without anyone starting it (plan 2.3,
`lib/lifecycle.js`). A leader job runs every 30 minutes (`index.js`, job
`lifecycle`) and walks the stages in this order; the push types are the
stage names in `lib/notify.js` CATALOG:

| Stage | When | Opens |
|---|---|---|
| `trial_ending` | a free trial ends: `plus.status` is `trial` and `plus.until` is one to two days ahead, once per end date (plan 2.6a). "Deine Probezeit endet übermorgen" (or "morgen"), the store price follows, cancelling works any time in the iPhone settings. Transactional: outside the cap, see below | `/plus?from=trial_ending` |
| `billing_issue` | `plus.status` is `billing_issue`, or `cancelled` by a CANCELLATION with `cancel_reason` `BILLING_ERROR` (RevenueCat sends both for one failed payment, the later one wins the status); once per problem (`plus.eventAt`, last 14 days, no second push for an event within 14 days of one sent); the text points to the Apple ID's payment settings, the app opens only its own routes | `/plus?from=billing_issue` |
| `plus_expiring` | 3 days before `plus.until` of a present (source `referral`, `gift`, `waitlist`, `admin`), once per end date | `/plus?from=plus_expiring` |
| `cancel_survey` | `plus.status` is `cancelled` and the person cancelled: the CANCELLATION at `plus.eventAt` (`SubscriptionEvent`) has `cancel_reason` `UNSUBSCRIBE` or `UNKNOWN`, or there is none (a status the reconcile set); not for `BILLING_ERROR` (billing_issue) or `CUSTOMER_SUPPORT` (an Apple refund, nothing). Once per event (last 7 days): "warum?" | `/plus?from=cancel` |
| `plus_winback_3`, `plus_winback_30` | store plan expired (`source` store, `status` expired) 3 to 5 or 30 to 33 days ago, once per end date; the app shows the win-back offering | `/plus?from=plus_winback_3` / `_30` |
| `invite_reminder` | day 1 after `milestones.verifiedAt` (24 to 48 h), no `firstInviteAt`; its own text when `device.contactsPermission` is `denied` | `/contacts` |
| `first_call_hint` | day 3 (72 to 96 h), at least one contact who has this person too, no talk (neither `firstTalkAt` nor any `Talk`); names the one online last | `/friend?phone=…` |
| `yap_moment_invite` | day 7 to 10 without a talk (three days, so the day-1 push has left the seven-day cap), in the hour before the Yap Moment of `User.timezone` (Europe/Berlin without one, the zones `tickDailyMoments` starts; `lib/dailyMoment.js` momentFor), not for people who switched the Yap Moment off | `/` |
| `week_open` | Sunday 16:00 to 17:00 local (`zoneOf`: `timezone`, else `schedule.timezone`, else Europe/Berlin), week streak of 2 or more (`lib/stats.js` weekStreak, the stats screen's rule) and no talk this week; once per week | `/` |
| `friends_were_available` | 3 to 6 days without an ActiveDay, not during the onboarding (a new account's first 10 days); the come_back text unless a contact was available in those days | `/` |
| `come_back`, `come_back_30` | 14 to 20 and 30 to 40 days without an ActiveDay, then nothing more | `/` |

The three onboarding stages go only to new accounts: created (`_id`) at
most two days before `milestones.verifiedAt`. `routes/verify.js` sets
`verifiedAt` for older accounts on their next sign-in (new device, expired
token), and a veteran must not get the newcomer series. The inactivity
stages wait until a new account's onboarding is over (10 days), so its
onboarding pushes are not lost to the cap.

Each stage goes to a person once (per week, end date, store event or
inactivity episode where the table says so): the job claims it in
`User.lifecycle.sent` (stage key -> date) with a conditional update before
the push, so two instances never both send; a push that `lib/notify.js`
skips gives the claim back for a later tick inside the window, and so does
one Expo did not take (no ticket, e.g. an outage): its PushLog row is
removed too, so it costs no cap. A push token Expo would never take
(not in Expo's format) is skipped before the claim. A stage whose query
fails is logged and skipped; the others still run. The `select` queries on
`milestones.verifiedAt`, `plus.status` and `plus.until` have no index yet;
fine at today's size, add them once the user count grows.

Rules in `lib/notify.js`: switch `notificationPrefs.lifecycle` ("Erinnerungen
und Tipps", default on, `GET/PUT /me/notifications`), at most
`LIFECYCLE_CAP` = 2 lifecycle pushes per person in seven days (PushLog rows
`lifecycle:<stage>`, kept seven days; an assumption), at least 24 hours
apart (`LIFECYCLE_SPACING_MS`: two stages due at once never arrive
together, the second follows on a later tick inside its window; skip reason
`lifecycle_spacing`), not counted towards the daily social cap, never in quiet hours,
and none within 24 hours of a `contact_available` push (a friend free right
now has precedence). The tone stays without pressure: no "streak breaks".
`trial_ending` is marked `transactional` in the CATALOG: a notice like a
receipt, so it neither counts towards nor waits for the cap, the spacing or
the `contact_available` precedence (no `lifecycle:` PushLog row); the
switch `lifecycle` and the quiet hours still hold.

`POST /me/state { notifications?, contactsPermission? }` (token only, 401
without; each `granted`, `denied` or `undetermined`, anything else 400) stores what the device says
about its permissions in `User.device { notifications, contactsPermission,
at }`, only when a value changed or the last write is two hours old; the
answer is `{ success, device }`. The export lists it under
`devices.permissions`, the stages sent under `lifecycle`.

Measured per type in every day's snapshot (`MetricsDaily.lifecycle`,
`lib/metrics.js` lifecycleDay) until there is an event log: `sentByType`
(sent that day), `activeNextDay` (`{ sent, active }`: the pushes of the day
before, with an ActiveDay on this day) and `talk48h` (`{ sent, talked }`:
the pushes of two days before, with a talk within 48 hours). PushDecision
lives three days, so these are the latest cohorts a day can judge; the T-2
decisions are gone during the next day, so a recount (METRICS_VERSION) keeps
`talk48h` of a final snapshot from age 1 and the whole block from age 2
(`RAW_TTL_DAYS`). Target (assumption): opt-out of `lifecycle` under 5 %.
Not measured yet (later, with an event log): the opt-out rate itself and a
D7 activation comparison of cohorts with and without lifecycle pushes.

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

## Error tracking (Sentry)

Crashes and unhandled request errors of the backend go to Sentry (EU region,
free tier), next to the app's native crash reports (CMM `services/sentry.ts`,
plan 2.1a). `lib/sentry.js` starts first thing in `index.js`, before express
is loaded, and only when `SENTRY_DSN` is set (never under tests):

- release = `RENDER_GIT_COMMIT`, environment = `SENTRY_ENVIRONMENT`
  (default `production`), no performance tracing (`tracesSampleRate: 0`),
  `sendDefaultPii: false`;
- what is reported: errors that reach Express's error handler with a 5xx
  (`setupExpressErrorHandler` in `app.js`), and the crash handlers in
  `index.js` (`unhandledRejection`, `uncaughtException`, a failed start) as
  `fatal`, flushed for at most 800 ms before the process exits (the exit
  still comes after 1 s); Sentry's own handlers for those two are left out,
  so a crash is reported once;
- scrubbing (`scrub`, `beforeSend` and `beforeBreadcrumb`): no Sentry user
  (the backend never sets one), no request body, cookies, query string or
  headers except `user-agent`, `x-app-version`, `x-app-build`,
  `x-app-update`, `x-platform`; in every string of the event phone numbers
  (`+49…`, spaced, URL-encoded `%2B49…`, bare runs of 10–15 digits as in
  Cloudinary ids) become `[Nummer]` and e-mail addresses `[E-Mail]`; URLs of
  breadcrumbs lose their query string. `test/sentry.test.js` checks it.

Alerts for new crashes come back through a webhook. Set up once, by hand:

- [ ] Sentry → Settings → Custom Integrations → Create New Integration →
      Internal Integration, name "Wanna yap? Alarme", Webhook URL
      `https://api.wannayap.app/webhooks/sentry`, "Alert Rule Action" on,
      **no** webhook subscriptions (leave `issue`, `error`, `comment` off);
      permissions: Issue & Event "Read". Copy the Client Secret into
      `SENTRY_WEBHOOK_SECRET` on Render.
- [ ] Per project, the alert rules decide which level alerts: Alerts →
      Create Alert → Issues, "A new issue is created", filter "The event's
      level is equal to fatal", action "Send a notification via Wanna yap?
      Alarme" (app project: only this rule, the app reports every handled
      error as level `error`; backend project: a second rule with level
      `error`, a 5xx there is worth a look).

Why no `issue` subscription: those webhooks go out for every new issue of
the whole organisation, past every alert rule and its filters. Each new
handled error of the app (a network timeout, say) would become an SMS. If
it is switched on anyway (as a fallback), `issue` / `created` alerts only at
level `fatal`, in every project; `error` alerts only through a rule
(`event_alert`).
- [ ] `SENTRY_DSN` of the backend project on Render; data region EU, sign
      the DPA in Sentry (Settings → Legal & Compliance), `COMPLIANCE.md`.

`POST /webhooks/sentry` checks `sentry-hook-signature` (HMAC-SHA256, hex,
over the raw body with `SENTRY_WEBHOOK_SECRET`, constant-time compare; the
route sits before the JSON parser, body limit 256 kB). Without the secret or
with a wrong signature it answers 401 and counts `sentryUnauthorized` (day
counter). `sentry-hook-resource` `event_alert` (level `fatal` or `error`
from `data.event`, filtered by the rule) and `issue` with action `created`
(level `fatal` only, from `data.issue`) raise the alert `sentry_fatal`
(level error: push, mail, SMS) after the answer; everything else is
answered 200 and ignored. Only Sentry links (`https://sentry.io/…`,
`https://<org>.sentry.io/…`) go into the text; the project is its slug
(from `project.slug` or the event's API url `…/projects/<org>/<slug>/…`),
a bare numeric project id is left out. `sentry-hook-timestamp` is not
checked: Sentry does not sign it, so it would not stop a replay; a replayed
call raises at most the same alert, at most once an hour.

## Releases and deploys

Render deploys `main`. `.github/workflows/test.yml` runs the suite on every
pull request and push; after a green run on `main` its job `tag` sets an
annotated tag `api/<YYYY-MM-DD>-<short sha>` (date in Europe/Berlin) on that
commit. So every backend version that passed the tests is findable as a
rollback target (Render → the service → Events → "Rollback" to that commit,
or a revert on `main`), and Sentry's release (`RENDER_GIT_COMMIT`) matches
it. Only that job has `contents: write`; a re-run skips an existing tag.
The deploy window (never within ±15 minutes of the Yap Moment) is in
`CMM/docs/RUNBOOK.md`. Optional, by hand: Render → the service → Settings →
Auto-Deploy "After CI Checks Pass", so a red `main` is never deployed.

## Backup

`.github/workflows/db-backup.yml` dumps the production database every Sunday
03:17 UTC (and on "Run workflow"): `mongodump --archive --gzip`, encrypted
with [age](https://github.com/FiloSottile/age) against the public key, then
`aws s3 cp` to `s3://<bucket>/mongo/<YYYY-MM-DD>.archive.gz.age` at an
S3-compatible endpoint (Backblaze B2 or Cloudflare R2, free tier). The
newest 8 dumps stay in the bucket, older ones are deleted after each upload.
The plain archive never leaves the runner and is deleted right after
encryption; the run fails with an `::error::` naming the missing secret when
one is not set. GitHub mails the owner when a scheduled run fails. With the
optional secrets `BACKUP_PING_URL` (`https://api.wannayap.app/ops/backup-done`)
and `BACKUP_PING_KEY` (the same value as the env variable on Render) the
last step posts the dump's name and size to the backend, which stores
`AppConfig.ops.lastBackupAt` and raises the alert `backup_stale` when no
dump reported for 8 days; without them the step is skipped. The console
shows the last backup under App → Betrieb.

GitHub secrets (Settings → Secrets and variables → Actions):

| Secret | Purpose |
|---|---|
| `MONGODB_URI` | Connection string of the production cluster; a user with read access to the database is enough. It must name the database (`…mongodb.net/wannayap?…`), so only that database is dumped and restored, not `admin` and everything else on the cluster |
| `BACKUP_AGE_PUBLIC_KEY` | The public half of the age key pair (`age1…`), from `age-keygen -o backup-key.txt` |
| `BACKUP_S3_ENDPOINT` | `https://s3.<region>.backblazeb2.com` or `https://<account>.r2.cloudflarestorage.com` |
| `BACKUP_S3_BUCKET` | Bucket name (private, no public access) |
| `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` | A key limited to that bucket with read, write and delete |
| `BACKUP_PING_URL`, `BACKUP_PING_KEY` | Optional: where and with which key the run reports the finished dump (see above) |

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

## Alerts

`lib/alerts.js` runs 17 rules every 30 minutes on the job leader, right
after the metrics snapshots (`index.js`). A hit goes out through
`alert(tag, text, { level })`: at most once an hour per tag, and only once
a day while the text is unchanged (one `AlertState` document per tag keeps
`lastAt`, `lastText`, `count`, so a new leader after a deploy doesn't
repeat it, and a day counter that stays red doesn't page every hour), as a
push over the console's
`alerts` kind (owners, `lib/adminPush.js`), as a mail to every owner admin
(`lib/mailer.js`, only with `SMTP_URL`) and, for level `error`, as an SMS
to `AppConfig.ops.alertPhone` (Console → App → Betrieb, "Alarm-SMS an";
needs `TWILIO_SMS_FROM`; `GET /admin/config` shows the number only to
owners, others get `•••`). The "Heute" card lists the last alerts
(`GET /admin/alerts`, viewer); the morning push names the tags of the last
12 hours. What to do in detail: `CMM/docs/RUNBOOK.md`, section "Alarme".
Rules people notice in the app (`sms_failures`, `push_failures`,
`push_credentials`, `agora_tokens`) also switch the outage banner on and off
(see Outage banner). `test/docs-drift.test.js` fails when a tag has no row
here (or, with the app repo checked out next to this one, in the runbook).

| Tag | Level | Fires when | What to do |
|---|---|---|---|
| `sms_failures` | error | today `smsFailed / smsStarted > 20 %` with at least 5 starts (`lib/opsCounters.js`) | Twilio console: balance, Verify service status, Fraud Guard; pause SMS in the console if it is pumping |
| `push_failures` | warn | of the pushes tried in the last 60 minutes (`PushDecision` result `sent`/`failed`) more than 10 % failed or got an error receipt, at least 20 tried | Expo status and `GET /api/push-health`; a single bad app build shows in Console → Fehler |
| `push_credentials` | error | `pushCredentialErrors > 0` today: Apple/Expo refused our credentials (`InvalidProviderToken`, `ExpiredProviderToken`, `TopicDisallowed`, `MismatchSenderId` …; counted in `lib/push.js` and `lib/receipts.js`, not for dead device tokens) | Renew the APNs key / Expo credentials (`VOIP_KEY_*`, EAS credentials), redeploy |
| `agora_tokens` | error | today more than 5 Agora tokens failed (`rtcTokenFailed`: no `AGORA_APP_CERTIFICATE`, or the builder threw) and more than 20 % of the tokens handed out (`rtcTokenIssued`); both day counters from `POST /rtcToken` (`app.js`). Sets the outage banner "Anrufe sind gerade gestört." | Render → Environment: `AGORA_APP_ID` and `AGORA_APP_CERTIFICATE` present and matching the Agora console project (certificate enabled, not rotated without redeploy); Agora status page; Render logs for "Fehler beim Erstellen des Tokens" |
| `tick_late` | error | the tick's own stamp `tickAt` on the `jobs` lock is older than 3 minutes (`lib/leader.js` `asLeader` with `tick: true`; the other jobs under the lock refresh only `lastRunAt`), not during the first 5 minutes after a start (`STARTUP_GRACE_SEC` as for `/healthz`) | `/healthz` and Render logs; restart the service if the leader hangs |
| `moment_missing` | warn | after 21:30 Berlin time today's `DailyMoment` for Europe/Berlin has no `sentAt` | Check `tickDailyMoments` errors in the logs; the tick may be stalled (see `tick_late`) |
| `client_errors` | warn | a new `ClientError` with `fatal` (kept only from a signed-in app, the report carries the token) in the last 60 minutes, or today's reported errors are more than three times yesterday's with at least 10 (`clientErrors` day counter, `routes/diagnostics.js`) | Console → Fehler: message, stack, versions and OTA updates (`ClientError.updates`); hotfix (OTA) or raise `minBuild` |
| `revenuecat` | error | today `rcUnauthorized > 0` (wrong `REVENUECAT_WEBHOOK_SECRET`) or `rcUnknownUser > 0` (`routes/plus.js`) | Compare the secret in RevenueCat and on Render; for unknown users find the purchase in RevenueCat and grant Plus by hand |
| `purchase_failures` | warn | today's paywall failures `purchaseError + restoreError + offeringEmpty > 3` (day counters from `POST /me/plus/funnel`, `lib/paywall.js`; `purchaseCancel` is the person's choice and does not count) | Console → Plus (Paywall row: which failure); App Store Connect status (agreements, tax, banking; products "Ready to Submit"/approved), RevenueCat dashboard (offering `default` current, products attached, App Store key valid); a single build: Console → Fehler |
| `agent_silent` | warn | the newest `AdDraft` is older than 36 hours (only once one ever existed) | GitHub → Actions → marketing-agent: re-enable the schedule (paused after 60 days without commits) or read the failed run |
| `agent_failed` | warn | not a rule here but `POST /marketing/notify { failed: true, step, runUrl }` (`lib/marketing.js` reportRun): the workflow `marketing-agent` failed in a step (its `if: failure()` step reports it). The text names the step and the GitHub run link, never the error message | Open the run link (GitHub → Actions → marketing-agent): a provider outage (Anthropic, Google, Cloudinary) needs nothing, the next scheduled run tries again; a refused key or an exhausted spend limit: renew it in the repo secrets; a code error: fix it in the CMM repo (`marketing/agent`) |
| `support_overdue` | warn | an open `SupportTicket` whose last message is from the user and older than 24 hours (`overdueTickets` in `lib/today.js`, the same count the morning push shows) | Console → Support: answer |
| `social_token` | warn | a connected `MarketingChannel` whose token (TikTok: refresh token) expires within 7 days | Console → Freigabe → Kanäle: reconnect |
| `no_talks` | error | yesterday's snapshot has `users.dau > 20` and `talks.count == 0` | Call delivery is broken: VoIP push, Agora certificate, `GET /api/push-health` |
| `backup_stale` | warn | `AppConfig.ops.lastBackupAt` exists and is older than 8 days | GitHub → Actions → DB-Backup: failed or paused run, see Backup |
| `sms_cap` | warn | today's `smsStarted` is at 80 % of `ops.smsPerDay` | Real demand: raise the cap (Console → App → Betrieb); otherwise suspect SMS pumping and narrow `smsRegions` |
| `gift_days` | warn | the gift days of the last 7 days (today and the six before; day counters `giftDays_referral`, `giftDays_waitlist`, `giftDays_admin`, see Invite rewards) are over `AppConfig.goals.giftDaysPerWeek` (default 200, assumption) | Console → Plus: where the days come from (Geschenk-Tage 7 Tage). A wave of real invites: raise the budget (Console → App → Ziele); a single source running away (one inviter, console grants): look at it; the experiment `referral_two_sided` too expensive: switch the flag off |
| `pepper_changed` | warn | not a rule here but `lib/pseudonyms.js` at start: the stored `phoneHmac` of accounts did not match the current `PHONE_HASH_PEPPER` and was re-keyed together with their `ActiveDay` rows (see Pseudonymous data) | Expected once, right after `PHONE_HASH_PEPPER` was set on Render after the first deploy. Otherwise: the variable or `JWT_SECRET` changed, or something ran against the production database with another env; restore the old value, the next start re-keys back |
| `review_login` | warn | the App Store review demo login (`REVIEW_PHONE`/`REVIEW_CODE`, `routes/verify.js`) is on without `REVIEW_UNTIL` ("Demo-Zugang ohne Ablaufdatum aktiv"), `REVIEW_UNTIL` has passed while `REVIEW_PHONE` or `REVIEW_CODE` is still set, valid or not ("Demo-Zugang abgelaufen"), or `REVIEW_UNTIL` is no date (the login is then off) | Render → Environment: set `REVIEW_UNTIL` to the last day the review needs it (a week after submitting is plenty), or remove `REVIEW_PHONE`, `REVIEW_CODE` and `REVIEW_UNTIL` once the review is through |
| `sentry_fatal` | error | not a rule here but `POST /webhooks/sentry` (`routes/webhooks.js`): an alert rule with the action "Send a notification via Wanna yap? Alarme" fired (`event_alert`, level `fatal` or `error`; the rules decide per project: app fatal, backend fatal and error), or, only if the integration's `issue` webhooks are on, a new issue with level `fatal` in any project (`issue`, action `created`); signed with `SENTRY_WEBHOOK_SECRET`. The text names project, level, release, short issue id and the Sentry link, never the message. Like every tag at most once an hour: a second new crash within the hour shows only in Sentry | Open the link: which build/commit, how many users. App: OTA hotfix or raise `minBuild`, pause the phased release; backend: roll back on Render to the last `api/…` tag (see Releases and deploys) |
| `owner_silent` | warn | not a rule here but the dead-man check in `lib/adminPush.js` (see Team): no owner acknowledged the morning push or signed in for 7 days; once per 7 days | Owner: open the console. Emergency contact: `CMM/docs/EMERGENCY.md` |
| `weekly_silent` | warn | not a rule here but the dead-man check in `lib/adminPush.js` (see Weekly report): the weekly report has gone out for at least 14 days (`AppConfig.ops.weeklyReportFirstAt`) and no active owner acknowledged one (`WeeklyReview.ackAt`) in the last 14 days; only while `owner_silent` does not hold; once per 7 days, mail to the emergency contact or push to the owners | Owner: Console → Woche, enter the hours and acknowledge (support's acknowledgements do not count). Emergency contact: ask whether everything is fine, `CMM/docs/EMERGENCY.md` |

## Outage banner

People should learn about an outage from a calm line in the app, not from
an error dialog (plan 2.15). Alert rules with `userFacing: { text }` in
`lib/alerts.js` drive `AppConfig.banner` through `lib/statusBanner.js`:

| Tag | Banner text |
|---|---|
| `sms_failures` | Die Anmeldung per SMS ist gerade gestört. Wir arbeiten dran. |
| `push_failures`, `push_credentials` | Mitteilungen kommen gerade verzögert an. Wir arbeiten dran. |
| `agora_tokens` | Anrufe sind gerade gestört. Wir arbeiten dran. |

- **On:** every rules run in which such a rule fires sets `banner = {
  enabled: true, text, level: "warning", until: null, source:
  "alert:<tag>" }`, independent of the alert's own debounce, and sends the
  socket event `appConfig` with the public config (as `PUT /admin/config`).
  The rules run with the alerts every 30 minutes and, for the banner alone
  (no alert), in the leader job `banner` every 5 minutes (`index.js`,
  `runBannerRules`), so the banner follows an outage within about 5 minutes
  of the counters showing it (plan goal: banner within 5 minutes). Open
  apps show it at once, others on their next start; the landing page
  wannayap.app reads the same `GET /app-config` (`banner: { text, level,
  until }` or `null`).
- **Recent, not all day:** `sms_failures`, `push_credentials` and
  `agora_tokens` alert on the day's counters (Europe/Berlin). Their banner
  additionally needs the same threshold over the last one to two hours
  (`userFacing.acute`, hour rows of `smsStarted`, `smsFailed`,
  `pushCredentialErrors`, `rtcTokenIssued`, `rtcTokenFailed` in
  `lib/opsCounters.js` `countsOfRecent`: this UTC hour and the one before).
  So a single refused push credential in the morning or a fixed Agora
  certificate takes the banner down within two hours, while the alert text
  still reports the whole day. `push_failures` already looks at the last
  60 minutes.
- **Off:** the first run in which the banner condition is false again
  switches the banner off, only while `banner.source` is still
  `alert:<tag>`, and sends `appConfig` again. Rules switching off are
  applied before rules switching on, so a second outage takes the banner in
  the same run.
- **Hand wins:** an automatic banner only takes a banner that is off or
  expired; one the owner set stays. Both steps are one conditional update
  on `banner.source`. The console sends the banner only when it was edited
  in the App tab, together with `bannerSeen` (the banner as loaded);
  `saveConfig` refuses the save with `banner_changed` when the stored
  banner is no longer that one (an alert switched it on or off since the tab
  was loaded), and the console loads the current banner and keeps the other
  inputs. So a stale tab can neither turn an ended outage text into a
  permanent hand banner nor silently switch off a fresh automatic one. A
  save that changes text, switch, level or end makes the banner the
  owner's (`source: null`) and mutes the automatic one: `banner.muted`
  gets the sources of every rule with the same text (switching off the
  `push_credentials` banner also keeps `push_failures` from bringing the
  same line back). A source leaves `muted` once no rule of its text fires
  any more; switching another alert's banner on never clears it. So
  "Banner jetzt abschalten" in the console holds for the rest of the
  outage. Two alerts with different texts at once: the first keeps the
  banner; when it ends, the same run hands it to the other.
- **Support:** a ticket opened while an automatic banner is on gets an
  immediate answer (`by: "auto"`): "Danke für deine Nachricht! Gerade gibt
  es eine bekannte Störung: <Bannertext> Wir melden uns, sobald sie behoben
  ist." The ticket stays open: the automatic answer is no answer from a
  person, `support_overdue` and the morning push still count it, and the
  console marks it "Automatisch".
- **Postmortem:** every alert with an effect on users (these four tags)
  gets a postmortem in `CMM/docs/incidents/`, written after
  `CMM/docs/POSTMORTEM-TEMPLATE.md` (timeline, cause, alert yes/no, measure
  as an issue).

## Team

The console has three roles (`models/Admin.js`): `owner` (everything,
including the team, settings and exports), `support` (users, reports,
moments, support tickets) and `viewer` (numbers only). The first owner is
created once through `POST /admin/auth/setup` with `ADMIN_API_KEY`; everyone
else is invited (plan 1.8).

- **Invite** (Console → Team, owner only): `POST /admin/admins { email, role }`
  creates an inactive admin (`active: false`, `totpEnabled: false`) with a
  one-time setup token (`inviteTokenHash`, SHA-256 of the token;
  `inviteExpiresAt` 7 days; `invitedBy`) and mails the link
  `<PUBLIC_API_URL>/console/#setup/<token>` (`lib/mailer.js`). Without
  `SMTP_URL`, or when the mail fails, the answer carries `link` for the owner
  to pass on. Someone deactivated or not finished is simply invited again
  (new token, old password, code and sessions void). The link opens the
  console's setup page: `GET /admin/auth/invite/:token` says whom it is for,
  `POST /admin/auth/setup { inviteToken, password }` sets the password and a
  fresh TOTP secret regardless of how many admins exist (the token stays valid
  until the code is confirmed, so an interrupted setup starts over),
  `POST /admin/auth/setup/confirm` activates. Audited as `admin_invited`,
  `setup_started`, `setup_done`.
- **Roles**: `PUT /admin/admins/:id { role }`, audited as `admin_role`. The
  last active owner can't be demoted (`409 last_owner`).
- **Deactivate**: `DELETE /admin/admins/:id` sets `active: false` and bumps
  `sessionVersion` (signed out at once; no pushes, no alert mails), never
  yourself (`400 self`) and never the last active owner (`409 last_owner`).
  The record stays for the audit trail; audited as `admin_deactivated`.
  `GET /admin/admins` lists everyone without secrets.
- **Lost authenticator, no second owner**: in the Render Shell run
  `node scripts/reset-admin-totp.js <email>`. It switches TOTP off, draws a
  new secret, signs out every session and prints a setup link (7 days) that
  runs through the same invitation flow (new password, scan the new secret).
  Passkeys and settings stay. With a second owner, "Erneut einladen" in
  Console → Team does the same. Use the link soon: until the setup is
  confirmed the admin counts as invited, and the console offers the login
  page, not the first-time setup.
- **Acknowledgement**: the morning push (`lib/adminPush.js` dailyDue) links
  to `#ack`; opening it makes the console call `POST /admin/daily/ack`
  (every role), which sets `Admin.lastAckAt`.
- **Pushes** (`Admin.notify`, switchable per admin in Console → ⚙︎):
  `approvals`, `posting` (owners), `support`, `reports` (owners, support),
  `daily` (everyone, at `notify.dailyHour`), `alerts` (owners), `weekly`
  (everyone, the weekly report on Monday, opens `#weekly`; see Weekly
  report).
- **Dead-man rule**: `adminPush.deadManCheck`, a leader job every hour. When
  no active owner acknowledged or signed in (`lastAckAt`, `lastLoginAt`)
  within 7 days: a mail to `AppConfig.ops.emergencyContact` (Console → App →
  Betrieb, "Notfallkontakt"; owners see the address, others `•••`), pointing
  at `CMM/docs/EMERGENCY.md`; without a contact a push "Quittung fehlt seit
  7 Tagen" to the owners. At most once per 7 days, booked in `AlertState`
  under `owner_silent` (so it shows in the console's alert list). When the
  mail cannot go out (no `SMTP_URL`, SMTP error) the owners get the push
  instead, saying that the contact was not reached; the next mail attempt
  is 7 days later. Name a person, set the address, and tell them where
  `EMERGENCY.md` is; create that file before you set the address. The
  second condition, `weekly_silent` (plan 2.11), takes the same way: see
  Weekly report.

## Weekly report

Plan 2.11: one report a week instead of dashboards, then a 30-minute
review (`lib/weeklyReport.js`, `routes/adminWeekly.js`).

- **What**: `report(week)` condenses the last full week (Monday to Sunday,
  Europe/Berlin, ISO week `YYYY-Www`) from the `MetricsDaily` snapshots and
  the functions of `lib/metrics.js`, no second data source; a finished day
  without a final snapshot is counted on the spot (`saveDay`, within the
  60-day backfill). Sections: north star (`activation4w` against
  `goals.activationPct` with its sample, density, WAU of the Sunday against
  the Sunday before, talks), cohorts (`retention`: W1 = signed up the week
  before and active in this one, W4 = signed up four weeks before; under 50
  people "kleine Stichprobe"), invites (`growth.inviteVisits`,
  `joinedViaInvite`, `users.new`, k = joinedViaInvite / new), new people by
  source (`growth.bySource`), Plus (sums of `newPaid`, `cancelled`,
  `expired`, `trialsStarted`, `trialsConverted`, MRR of the Sunday),
  paywall (`plus.funnel`; under 200 views a week shown, not judged), SMS
  per sign-up (`ops.smsStarted / users.new`), variable costs
  (`costs.variableEurCents`, prices are assumptions), alerts whose latest
  firing (`AlertState.lastAt`) fell into the week (an alert that fired
  again later shows in that later week only), what waits now (open
  tickets, those over 24 hours as in `lib/today.js`, videos for approval,
  open reports), user research (`User.research.doneAt` in the week, goal
  5), the seed cluster (sign-ups with `acquisition.campaign` =
  `goals.seedCampaign` from `growth.byCampaign`, without a seed campaign
  the sign-ups through invites, against `goals.seedSignupsPerWeek`,
  default 30, an assumption; Console → App → Ziele) and the hours of
  operations of the newest acknowledged week up to this one (all admins
  added up, goal under 5 h). Returns `{ week, from, to, headline, title,
  missingDays, sections: [{ key, title, lines, data }], text }`; `text` is
  the plain text of the mail and the console.
- **Sending**: leader job `weekly` every 15 minutes (`index.js`,
  `weeklyDue`): due from Monday 08:00 Europe/Berlin (a run missed on Monday
  catches up later that week; a fresh deploy mid-week sends the last week
  once), once per week. `AppConfig.ops.weeklyReportFor` (the ISO week) is
  claimed with a conditional update before anything goes out, so a second
  run or a second leader sends nothing; `ops.weeklyReportAt` is the last,
  `ops.weeklyReportFirstAt` the first report. A mail to every active owner
  (`lib/mailer.js`, subject "Wanna yap? Woche <KW>: <Kernzahl>", only with
  `SMTP_URL`) with the link `<PUBLIC_API_URL>/console/#weekly`, and the
  console push kind `weekly` (title "Wochenreport KW <n>", `#weekly`).
  Without an owner (fresh install) nothing is sent or claimed.
- **Review**: `GET /admin/weekly?week=YYYY-Www` (viewer; default the last
  full week; a future week or the running one is `400 invalid_week`)
  returns `{ report, reviews: [{ email, hours, decisions, ackAt }],
  previousWeek, nextWeek }` (`nextWeek` null for the newest).
  `POST /admin/weekly/ack { week, hours: { alerts, support, approvals },
  decisions }` (owner and support, audited as `weekly_ack`) stores one
  `WeeklyReview` per week and admin (a second ack replaces it); the week
  may be any past one or the running one. All three hours are required
  (`400 hours_required`), numbers 0–80, strings with a comma work,
  rounded to one decimal (`400 invalid_hours`); up to three decisions of
  at most 300 characters, empty ones dropped (`400 invalid_decisions`).
  The console tab "Woche" (`#weekly`, `#weekly/2026-W39` for an older one)
  shows the text, the acknowledgements and the form with the placeholders
  "Kanal +/−", "Hook-Thema für den Agenten", "Budget".
- **Decisions**: the owner writes the decisions into
  `CMM/docs/DECISIONS.md` by hand as well; the hook topic goes into
  Console → App → "Marketing-Hinweise für den Agenten"
  (`AppConfig.marketingNotes`, up to 1000 characters, `PUT /admin/config
  { marketingNotes }`, owner; null or empty clears it), which the agent
  reads as `notes` from `GET /marketing/context`. Never sent to the app.
- **Dead-man** (`weekly_silent`, `lib/adminPush.js` deadManCheck, hourly):
  the report has gone out for at least 14 days and no active owner
  acknowledged one within the last 14 days → a mail to
  `AppConfig.ops.emergencyContact` naming the reason, without one (or when
  the mail fails) a push "Wochenreport seit 14 Tagen offen" (`#weekly`) to
  the owners; once per 7 days, booked in `AlertState`. Checked only while
  `owner_silent` does not hold, so the contact never gets two mails about
  the same silence.

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
needs `REVENUECAT_API_KEY`. The rules of that answer live in
`lib/plusReconcile.js` `applyStoreState`, shared with the nightly job below.

### Revenue as a time series (plan 2.4)

`lib/metrics.js` `plusDay` writes `MetricsDaily.plus` for every day from the
production events of the day (sandbox never counts): `newPaid`
(INITIAL_PURCHASE outside a trial), `trialsStarted` (with TRIAL),
`trialsConverted` (a RENEWAL whose user's latest earlier paid event was a
TRIAL), `renewed`, `cancelled`, `billingIssue`, `expired`, `refunds`
(CANCELLATION with `cancel_reason` CUSTOMER_SUPPORT), the active plans at
the end of the day by source (`activeStore`, `activeGift` = admin,
referral, waitlist, gift; `activeSandbox`) and `mrrCents`: for every active
store plan the price of the user's last paid event (purchase currency, else
USD), yearly products divided by twelve; assumption: everyone pays in EUR,
so the sum is shown as euros (a purchase in another currency would be added
at face value). `giftDaysGranted { referral, waitlist, admin }` and
`giftToStore` are the gift budget of plan 2.12 (see Invite rewards).
`User.plus` has no history, so a day recomputed later gets today's active
counts; the event counts stay exact. Rule: these numbers steer decisions
only from about 30 active store plans on (assumption); the console says so
below that.

`MetricsDaily.version` is the `METRICS_VERSION` of `lib/metrics.js`; when
it is raised, `runSnapshots` recomputes finished days of the last 30 days
with an older version, five per run, so a new column reaches the recent
past. Only within the raw data's life: a column whose rows have expired
(`RAW_TTL_DAYS`: `push.*` after 3 days, `rituals.nudges` after 7, `calls.*`
and `circles.rooms`/`ritualRooms` after 30, each a day early to be safe)
keeps the stored value, so a recount never turns a real number into a
zero. `retention()` adds `paid30` per cohort (share with a production
INITIAL_PURCHASE within 30 days of signing up; null until the cohort's 30
days are over), `funnel()` the onboarding steps per sign-up week from
`User.milestones` (`GET /admin/metrics/funnel`, viewer), `density()` the
histogram `c0 · c1_2 · c3_5 · c6plus`. The console shows the "Umsatz" row
and the MRR chart in the Plus tab; the morning push adds "Plus: +2 neu ·
1 gekündigt · MRR 84 €" on days with subscription events or MRR.

### Paywall funnel, limit hits, trials (plan 2.6a)

Without an event log the paywall is measured in day counters
(`lib/opsCounters.js`, names camelCase without `_`), all in
`lib/paywall.js`:

- `POST /me/plus/funnel { step, from }` (token, 401 without; 120 per hour
  per user) answers `{ success: true }`. `step` is one of `paywall_view`,
  `purchase_start`, `purchase_success`, `purchase_cancel`,
  `purchase_error`, `restore_success`, `restore_error`, `offering_empty`,
  anything else is 400 `{ success: false, error: "invalid_step" }`. `from`
  is where the app opened the paywall (`/plus?from=...`): `settings`,
  `memories`, `appicon`, `year`, `room`, `limit_circles`, `limit_rituals`,
  `limit_members`, `limit_moments`, `referral`, `plus_expiring`,
  `billing_issue`, `plus_winback_3`, `plus_winback_30`, `cancel`,
  `trial_ending`, `push`, `other`; unknown or missing counts as `other`.
  Each step raises its counter (`paywallView`, `purchaseStart`,
  `purchaseSuccess`, `purchaseCancel`, `purchaseError`, `restoreSuccess`,
  `restoreError`, `offeringEmpty`); views and purchases also per source
  (`paywallViewFromLimitCircles`, `purchaseSuccessFromSettings`, ...). No
  user is stored, testers are counted like everyone. The app also reports
  purchase and restore errors as a ClientError (`POST /diagnostics/errors`)
  for the details.
- Limit hits: every refusal by a plan limit counts `limitHit<Limit>`
  (fire and forget): `lib/plan.js` `limitError` (`circles`, `rituals`,
  `momentsPerDay`; a moment refused at `/upload/moment` and again at
  `/moment` counts twice, read it as attempts), a full circle
  (`circleMembers`) and a full round (`roomParticipants`) in
  `routes/circles.js`, a free round ended by time (`roomMinutes`,
  `lib/circles.js` `endStaleRooms`) and a call started as audio by the
  limit `video` (`lib/calls.js`).
- `computeDay` writes `MetricsDaily.plus.funnel { paywallView,
  purchaseStart, purchaseSuccess, purchaseCancel, purchaseError,
  restoreSuccess, restoreError, offeringEmpty, bySource: { <from>: { view,
  success } } }` (sources with a view or purchase only) and
  `MetricsDaily.plus.limitHits { <limit>: n }` (`METRICS_VERSION` 6, so the
  last 30 days are recounted from the counters). The metrics CSV adds
  `paywall_aufrufe` ... `angebot_leer` and `limit_treffer` (the sum).
- Console → Plus, section "Paywall": views → starts → purchases with the
  rate for the last 30 days, cancels and failures, the table per source
  and "Limit-Treffer 30 Tage" per limit. It steers only from 200 views a
  week (plan, principle 6); below that the console says to read, not judge.
- Trials: RevenueCat's `period_type` TRIAL sets `plus.status` `trial`;
  `trialsStarted`/`trialsConverted` (above) count them, and the lifecycle
  stage `trial_ending` tells the person two days before the store plan
  starts (see Lifecycle pushes). The 7-day intro offer, the 16-day billing
  grace period and Family Sharing for the yearly product are App Store
  Connect settings, not code; during the grace period RevenueCat reports
  BILLING_ISSUE and Plus stays on until `expiration_at_ms`.
- Feature flag `plus_interest` (Console → App → Feature-Flags, default off): only
  when it is on and the store is not live does the app's paywall show
  "Interesse zeigen" (`POST /me/plus-interest`, unchanged); otherwise
  without a store the paywall says "Plus kommt bald". The backend has no
  logic for it; the app reads it from `GET /app-config` (`flags`).

### Nightly reconcile

`lib/plusReconcile.js` `reconcile` compares every user with
`plus.source` store or sandbox against `GET /v1/subscribers/{id}` and
corrects `active`, `until` and `status` where they differ (a missed webhook,
a refund that never reached us); the status only counts when ours is one
the store can report (not null from before the field existed, not
`paused`), otherwise such users would be "corrected" every night. A
subscriber RevenueCat no longer knows ends the store Plus. Per-user errors are logged and the run continues. Day
counters `plusReconcileChecked`, `plusReconcileFixed` and
`plusReconcileFailed` (`lib/opsCounters.js`, in `MetricsDaily.ops`) show
the drift; the goal is 0 fixed. `runDue` runs it once a day between 03:00
and 05:00 Europe/Berlin on the job leader (`index.js`, checked every 15
minutes), booked in `AppConfig.ops.plusReconcileFor`; without
`REVENUECAT_API_KEY` nothing runs.

### Exports

`GET /admin/export/:name.csv` (`routes/adminExport.js`, owner, audited as
`export_<name>`) with `metrics` (one row per `MetricsDaily` day, flat, the
`plus.*` columns included, the gift budget as `geschenk_tage_einladung`,
`geschenk_tage_warteliste`, `geschenk_tage_konsole`, `geschenk_zu_store`, the paywall of plan 2.6a as `paywall_aufrufe`, `kauf_gestartet`, `kauf_erfolgreich`, `kauf_abgebrochen`, `kauf_fehler`, `wiederherstellen_ok`, `wiederherstellen_fehler`, `angebot_leer`, `limit_treffer`, and where the day's sign-ups came from (plan 2.10) as `herkunft_freund`, `herkunft_tiktok`, `herkunft_instagram`, `herkunft_flyer`, `herkunft_presse`, `herkunft_sonstiges`, `herkunft_ohne_antwort`, `android_freunde_mittel`), `plus` (one row per `SubscriptionEvent`, users by
id, no app user ids), `marketing-spend` (`MarketingSpend`) and `support`
(`SupportTicket` without phone numbers or message texts: id, category,
status, times, message counts, app version). Same CSV dialect as
`GET /admin/waitlist/export` (BOM, semicolon); the links sit in the Plus tab.

## Unit economics

Plan 2.5: what the app costs per day, per active user and per talk minute,
what a Plus subscription contributes, how many subscriptions cover the
costs, and how long the money lasts. Every price is an **assumption** from
public price lists (2026) until it is checked against the invoices on the
5th of the month; the console says "Annahme, gegen Rechnung prüfen".

**Quantities** (`MetricsDaily.costs`, `lib/metrics.js` computeDay, from
`METRICS_VERSION` 3 on): `smsStarted`, `smsChecked` (the day counters of
the sign-up SMS), `agoraAudioMinutes`, `agoraVideoMinutes` (participant
minutes of the day's talks: a 1:1 talk counts its seconds twice and takes
its mode from `Call.video`, a talk whose call has expired counts as video;
a round has one `Talk` per participant, each counted once, and rounds are
video), `cloudinaryUploads` (day counter, raised after a successful
`/upload/avatar` or `/upload/moment`), `pushSent` (= `push.sent`),
`voipSent` (day counter, raised when APNs accepted a VoIP push,
`lib/push.js`). All video counts as Agora's HD tier: 640×360 and 720p cost
the same and there is no cheaper SD tier, so the app reports no quality.
The Agora minutes keep their stored value once the calls have expired
(`RAW_TTL_DAYS`, 30 days).

**Prices** (`AppConfig.prices`, Console → App → Preise, owner;
`lib/appConfig.js` DEFAULT_PRICES): `smsEurCents` 8 (per started
verification), `agoraAudioUsdCentsPer1000Min` 99 and
`agoraVideoUsdCentsPer1000Min` 399 (US cents, Agora bills in dollars,
converted with `eurPerUsd` 0.92), `agoraFreeMinutesPerMonth` 10,000,
`cloudinaryEurCentsPerUpload` 0 (free tier), `pushEurCentsPer1000` 0,
`appleCommissionPct` 15 (Small Business Program; 30 without),
`plusMonthlyEurCents` / `plusYearlyEurCents` null (list prices for the
break-even before the first purchase; null takes the last production
purchase). `costs.variableEurCents` is the day's quantities at these
prices (euro cents, two decimals), `costs.perMauEurCents` that divided by
`users.mau` (null without MAU). Agora's free minutes are a monthly pool:
each day gets minutes per month / days of the month, credited to video
first (the lower bound of the invoice). A price change applies to days
counted from then on (today included); finished days keep the price they
were counted with until a `METRICS_VERSION` recount. Only the prices the
owner changed are stored (an emptied field, `null` over the API, puts a
price back to its default), so a corrected default in the code still
reaches every key nobody checked. The console reads a comma as the
decimal separator and refuses an ambiguous "8.125" instead of guessing.

**Fixed costs** (`AppConfig.fixedCosts`, Console → App → Fixkosten,
owner): up to 50 entries `{ service, monthlyEurCents, note, until }`,
service up to 60 characters, |cents| up to 100,000 €; ops items (uptime
monitor, Sentry, staging) belong here too. A credit (startup programme) is
a negative entry with `until`; an entry counts while `until` is empty or
not before today. The bank balance for the runway is
`AppConfig.ops.bankBalanceEurCents` (typed in under Fixkosten, null =
unknown), stamped with `ops.bankBalanceAt` on every change; only owners
see the amount (`"•••"` for support and viewer in `GET /admin/config` and
`GET /admin/economics`), the runway is for everyone.

**Numbers** (`lib/economics.js` summary, `GET /admin/economics`, viewer;
the "Unit Economics" row in the Plus tab): `month.variableEurCents` (the
last 30 finished days, scaled up to 30 when fewer have cost columns;
`days` says how many), `variablePerDayEurCents`, `fixedEurCents`,
`mrrCents` and `activeStore` (today's snapshot), `netRevenueCents` = MRR ×
(1 − commission), `contributionCents` = net revenue − variable costs,
`perMau`, `contributionPerMau` (contribution per active user and month;
the card also shows it per day), `minutesPerMau` `{ audio, video }` (Agora
participant minutes per active user and month), `perTalkMinute` (talk minutes as the stats count them: 1:1
minutes plus round minutes per participant), `perPlusSub` = average plan
price × (1 − commission) − variable costs per MAU (assumption: a Plus user
costs what an average active user costs), `breakEvenYearlySubs` /
`breakEvenMonthlySubs` = (fixed costs + variable costs of the free users) /
contribution per subscription of that kind, rounded up (null without a
price or with a contribution of zero or less), `burnEurCents` = fixed +
variable − net revenue, `runwayMonths` = bank balance / burn (null without
a balance or without a burn). The metrics CSV export carries the cost
columns (`agora_audio_min`, `agora_video_min`, `cloudinary_uploads`,
`voip_gesendet`, `kosten_variabel_cent`, `kosten_je_mau_cent`).

**Plan limits** (`lib/plan.js` DEFAULT_LIMITS, Console → Plus → Grenzen):
`momentsPerDay` (free 30, Plus 100, never above 200) is checked on
`/upload/moment` before Cloudinary is paid for and again on
`POST /moment/callmoment` (the app falls back to an inline picture when the
upload fails), counted on the person's `CallMoment`s of the day
(Europe/Berlin); the answer is 403 `plan_limit` with
`limit: "momentsPerDay"`. Uploads that never become a moment are braked
separately: at most 200 `/upload/moment` requests per person in 24 hours
(in memory, express-rate-limit keyed on the phone), then 429
`upload_limit`. `video` (true, false or whole video minutes
a month; true for both plans by default) decides in `lib/calls.js`
startCall whether a 1:1 call may use video: false, or the caller's video
minutes of the calendar month used up (answered video calls they started,
from `Call` and `Talk`), starts the call as audio; the result carries
`videoDowngraded: "plan_limit"` and the caller's socket hears
`callVideoDowngraded { reason, target, channel }`. With the defaults
nothing changes. Whether free calls default to audio or get a video
allowance is the owner's decision at the end of phase 2; the app has to
handle `callVideoDowngraded` before a limit other than true is set.

## Pseudonymous data

Two hashes of the phone number exist, for two reasons (plan 2.8,
`COMPLIANCE.md`):

- `User.phoneHash` = SHA-256 of the E.164 number (`User.hashPhone`). The app
  computes the same hash from the address book, so it is the key of
  `POST /contacts/match`, `Invite.toHash`, `Circle.invites.hash` and
  `BannedNumber.hash`. It has no secret and never gets one: over the small
  German number space it can be computed offline, so it is pseudonymous,
  not anonymous, and every row under it has its deletion path.
- `User.phoneHmac` = HMAC-SHA256 of the number with the server's pepper
  (`User.hmacPhone`, `PHONE_HASH_PEPPER`). Only the server knows the pepper,
  so the hash cannot be computed without it. It is the key of the analytics
  rows that outlive the request (`ActiveDay.who`, kept 400 days) and of
  every future analytics collection; it is never sent to the app. The
  re-match lists (`AddressBookHash.hashes`, plan 2.13) use the same pepper
  over the SHA-256 hash the app sends (see Re-match).

The pepper is set once and never changed: a new pepper gives every number a
new `phoneHmac`. Without the variable the pepper is derived from
`JWT_SECRET` (which then must not change either); the start logs
`PHONE_HASH_PEPPER not set`. Set it on Render **before the first deploy of
this version** (plan 2.8), keep it in the password manager with the other
secrets, and treat a rotation of `JWT_SECRET` as harmless only once
`PHONE_HASH_PEPPER` is set. Should the variable arrive late anyway, the
start repairs it: an account whose stored `phoneHmac` no longer matches the
current pepper has its `ActiveDay` rows moved to the new value and the
field updated (the start logs `phoneHmac re-keyed for N user(s)`). That
makes the one switch that happens in practice (fallback → real pepper)
lossless; any later change still costs the history of accounts deleted in
between and is not meant to happen. Whenever that repair ran, the owners get
the `pepper_changed` alert (see Alerts): expected exactly once, if the
variable was set after the first deploy of this version; at any other time
it means the variable or `JWT_SECRET` changed on Render, or a process with
another env (a local run against the production database) touched the data.
The start keeps a fingerprint of the pepper (SHA-256, never the pepper) in
`AppConfig.migrations.phoneHmacKey`: while it matches, only accounts without
`phoneHmac` are read, so the start does not grow with the user count; a
different pepper reads every account once and stores the new fingerprint.

Migration (`index.js` `migrate()`, `lib/pseudonyms.js`): on every start,
accounts without `phoneHmac` get it; once, marked in
`AppConfig.migrations.activeDayHmac`, the `ActiveDay` rows written under the
SHA-256 are re-keyed to the HMAC account by account (a day that exists under
both keys keeps the new row). Rows of accounts deleted before that run have
no account left to re-key them: they stay unreadable and expire with the
TTL. Rows the old instance still writes with the SHA-256 during the deploy
overlap stay as they are: deletion and export reach them through the three
keys, the active-user counts see that person twice for the windows that
contain the deploy day, once. `ActiveDay` has an index on `who` alone so the
migration, deletion and export never scan the collection; `migrate()`
creates it before the first run. No script to run by hand.

Deletion (`lib/account.js` `deleteAccount`): the `ActiveDay` rows go under
all three keys (the stored `phoneHmac`, the HMAC computed now and the
SHA-256), and with `REVENUECAT_API_KEY` set the subscriber is deleted at
RevenueCat (`DELETE /v1/subscribers/{our user id}`); a failure there is
logged and never stops the deletion. A waitlist code the account redeemed
(`WaitlistEntry.claimedBy`, SHA-256) keeps `deleted` as its claimant: the
code stays used, the hash is gone. The export (`GET /me/export`) lists the
days under `activeDays`.

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `MONGODB_URI` | yes | MongoDB connection |
| `JWT_SECRET` | yes | Signs auth tokens; without it no tokens are issued |
| `PHONE_HASH_PEPPER` | recommended | Pepper of the keyed phone pseudonyms (`User.hmacPhone`, `ActiveDay.who`), at least 32 random characters (`openssl rand -hex 32`); set once, before the first deploy of plan 2.8, and never changed, see Pseudonymous data. Without it the pepper is derived from `JWT_SECRET` and the start logs a warning |
| `AUTH_REQUIRED` | later | `true` rejects requests without a token |
| `ADMIN_API_KEY` | once | Key for the very first console account (`POST /admin/auth/setup` with `setupKey`, see Team); only works while no admin exists. Can be removed once the first owner is set up |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SID` | yes | SMS verification |
| `TWILIO_SMS_FROM` | alerts | A Twilio phone number (`+49…`) or Messaging Service SID (`MG…`) for alert SMS to `AppConfig.ops.alertPhone` (`lib/twilio.js`); without it alerts go out as push and mail only |
| `BACKUP_PING_KEY` | backup | Bearer key for `POST /ops/backup-done` (`routes/ops.js`), at least 24 characters; the same value is the GitHub secret of the backup workflow. Without it the endpoint refuses everyone |
| `AGORA_APP_ID`, `AGORA_APP_CERTIFICATE` | yes | Agora tokens (the old certificate was public and must be rotated) |
| `VOIP_KEY_CONTENT`, `VOIP_KEY_ID`, `VOIP_TEAM_ID` | iOS | APNs key for VoIP pushes |
| `VOIP_TOPIC` | no | Defaults to `com.schly21.kontaktlisteapp.voip` |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | yes | Avatar uploads |
| `EXPO_ACCESS_TOKEN` | no | Expo push |
| `SMTP_URL` | waitlist | SMTP for waitlist, alert, invitation and dead-man mails, e.g. `smtps://user:pass@smtp-relay.brevo.com:465`; without it no mail is sent |
| `MAIL_FROM` | no | Sender, defaults to `Wanna yap? <hallo@wannayap.app>` (the domain needs SPF/DKIM at the mail provider) |
| `SITE_URL`, `PUBLIC_API_URL` | no | Links in mails (waitlist, admin invitations, the TOTP reset script) and the campaign links and QR codes of the console (`SITE_URL`, see Acquisition and campaigns), default `https://wannayap.app` and `https://api.wannayap.app` |
| `WAITLIST_BATCH` | no | Launch mails per 15 s batch (default 40, max 200); keep under the provider's rate limit |
| `MARKETING_AGENT_KEY` | agent | Bearer key of the daily marketing agent (CMM repo, `marketing/AGENT.md`), at least 24 characters; without it `/marketing/*` refuses everyone |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | posting | TikTok developer app (Login Kit + Content Posting API); its redirect URI is `https://api.wannayap.app/marketing/tiktok/callback`. Connected in the console (Freigabe → Kanäle) |
| `ADMIN_PUSH_PUBLIC_KEY`, `ADMIN_PUSH_PRIVATE_KEY` | no | VAPID key pair for push to the admin console (`npx web-push generate-vapid-keys`); without them a pair is created once and kept in the database |
| `ADMIN_RP_ID`, `ADMIN_ORIGIN` | no | Passkeys (Face ID) for the console: the host and origin the console runs on, default the host of `PUBLIC_API_URL` and `https://` + that host |
| `ADMIN_PUSH_CONTACT` | no | Contact address sent to the push services, default `hallo@wannayap.app` |
| `REVENUECAT_WEBHOOK_SECRET` | purchases | The Authorization value RevenueCat sends to `POST /webhooks/revenuecat`; without it the webhook refuses everything |
| `REVENUECAT_API_KEY` | no | RevenueCat secret API key (v1) for `GET /v1/subscribers/{id}`: `POST /me/plus/sync` after a purchase in the app, the nightly reconcile of every store Plus (`lib/plusReconcile.js`, see Subscriptions), and a TRANSFER whose source we don't know; also `DELETE /v1/subscribers/{id}` when an account is deleted (see Pseudonymous data). Without it sync answers 501, the reconcile never runs, such a transfer grants Plus without end date (logged) and the subscriber stays at RevenueCat |
| `POST_SLOTS` | no | When approved ad videos go out, Europe/Berlin, default `12:00,18:00` (one video per slot) |
| `PORT` | no | Set by Render |
| `SENTRY_DSN` | no | DSN of the backend's Sentry project (EU region); without it nothing is sent, see Error tracking (Sentry) |
| `SENTRY_ENVIRONMENT` | no | Sentry environment, default `production` (e.g. `staging` for a second service) |
| `SENTRY_WEBHOOK_SECRET` | sentry alerts | Client Secret of the Sentry Internal Integration that calls `POST /webhooks/sentry`; without it the webhook refuses everything (401) |
| `REVIEW_PHONE`, `REVIEW_CODE` | no | App Store review demo login: this number signs in with this code (6–10 digits) without SMS; remove both after the review |
| `REVIEW_UNTIL` | with `REVIEW_PHONE` | Last day of the demo login, `YYYY-MM-DD` (Europe/Berlin); from the next midnight it is off (`reviewLogin: "expired"` in `/api/push-health`). Missing: the login stays on and the alert `review_login` reminds you |
| `RENDER_GIT_COMMIT` | no | Set by Render: the deployed commit, shown in `/healthz`/`/api/push-health` and used as Sentry release |
| `RENDER_INSTANCE_ID` | no | Set by Render: names the instance in the leader lease (`lib/leader.js`) and its log lines; without it the host name |
| `NODE_ENV` | no | Not needed on Render; never set it to `test` there. `npm test` runs with `test`: rate limits, Sentry and the `Secure` flag of the console cookie are off, mail counts as configured |
| `TEST_MONGODB_URI` | no | Tests only: `npm test` runs against this cluster (in its own `wannayap-test-<pid>` database) instead of the in-memory MongoDB; used in the restore drill, see Backup |
