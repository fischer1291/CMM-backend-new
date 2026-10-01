# CLAUDE.md

Backend of Wanna yap?, an iOS app for spontaneous calls among friends:
Node (CommonJS), Express 5, Socket.IO, Mongoose, deployed on Render from
`main`, one instance. The app lives in the `CMM` repo; the plan everything
follows is `CMM/docs/SCALE-PLAN.md`.

## Working here

- `npm test` runs the whole suite (`node --test`, in-memory MongoDB, about
  2.5 minutes); it must be green before a commit. Tests are `test/*.test.js`
  with `node:test` + supertest on the real app (`test/helpers.js` fakes
  Twilio, Expo, APNs and nodemailer; `fakes.mails`, `fakes.sms` …). Every
  route gets a test next to the ones of its module.
- Every file starts with a short comment that says why it exists, in
  English. Comments are English; everything a user or admin reads (API
  errors shown in the app, mails, pushes, the console) is German, "du",
  no pressure in tone.
- Reuse what is there: day counters `lib/opsCounters.js`, background jobs
  only through `asLeader` (`lib/leader.js`), admin routes with
  `requireAdmin(role)` and `audit()` (`lib/adminAuth.js`), config blocks
  with their own validation in `lib/appConfig.js` `saveConfig`, mail via
  `lib/mailer.js` `sendMail`, pushes to admins via `lib/adminPush.js`
  `tell`/`KINDS`, pushes to users via `lib/notify.js` `CATALOG`, alerts via
  `lib/alerts.js` `alert(tag, text)`, the console in `admin-ui/app.js`
  (htm + preact, no build step).
- Data fixes only in `migrate()` in `index.js` (idempotent, safe on every
  start, marked in `AppConfig.migrations` when they must run once). No
  ad-hoc migrations, no scripts that rewrite data without a note in the
  README.
- No new dependencies without a reason in the commit message; no secrets
  in the repo (env vars are listed in the README table). New env vars and
  console settings go into the README; privacy-relevant fields get a line
  in `COMPLIANCE.md`.
- Deploy window: never within ±15 minutes of the Yap Moment
  (`DailyMoment.at`, a random time between 10:00 and 21:00 per time zone,
  Europe/Berlin first), never during a launch mail batch. Render overlaps
  two instances for a moment; the leader lease handles the jobs.

## Glossary

- **Call**: one ring (`models/Call.js`), answered or not. **Talk**: an
  answered call with real talk time (`models/Talk.js`), the unit the stats
  and milestones count.
- **Moment**: a picture from a real call, shared once the other person
  agreed, visible to friends for 24 hours (`CallMoment`, `lib/moments.js`).
  **Yap Moment**: the daily ten-minute window at a random time per time
  zone when everyone is pushed to be reachable at once
  (`lib/dailyMoment.js`).
- **Plus** (Wanna yap+): the paid plan (`lib/plan.js`). `User.plus.source`:
  `store` (RevenueCat), `sandbox` (store purchase with a test account, never
  revenue), `admin` (console grant, `routes/admin.js`), `referral` (invite
  rewards after the invitee's first talk, `lib/referral.js`), `waitlist`
  (`lib/waitlist.js`), `gift` (listed in `models/User.js`, nothing writes it
  today; reserved for a manual present).
- **Owner / support / viewer**: console roles (`models/Admin.js`).
- **Leader**: the one instance that runs background jobs (`lib/leader.js`).

Operations docs (runbook, services, emergency, compliance) live in
`CMM/docs/`, not here: one place per topic.
