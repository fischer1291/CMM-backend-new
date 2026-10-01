# Datenschutz: Verarbeitungsverzeichnis, Auftragsverarbeiter, Änderungsprozess

Was das Backend über Personen speichert, wofür, wie lange und wie es wieder
verschwindet, aus dem Code abgelesen (Stand der Modelle in `models/`). Die
Datei liegt hier und nicht in `CMM/docs/`, weil `test/compliance.test.js` sie
bei jedem Testlauf gegen `models/` prüft: jede Datei dort braucht eine Zeile
in der ersten Tabelle, sonst ist die CI rot. Der Prozess dahinter steht in
`CMM/docs/PRIVACY-CHANGE.md`, die Datenschutzerklärung in
`CMM/content/legal.ts`.

Die Rechtsgrundlagen sind Vorschläge und **vom Anwalt zu prüfen** (Plan 1.6,
Anwaltspaket). "prüfen" markiert, was der Code nicht beantwortet. Zahlen und
Fristen stammen aus den TTL-Indizes der Modelle und aus `index.js`.

Telefonnummern stehen im Format E.164 (`+49…`). "Hash" ist SHA-256 der
E.164-Nummer ohne Salz (`User.hashPhone`): pseudonym, nicht anonym, also
personenbezogen. Admins sind die Personen mit Konsolenzugang (`Admin`), ihre
E-Mail-Adresse taucht als `by`, `decidedBy`, `updatedBy` in Betriebsdaten auf.

## Einwilligung und Mindestalter

Seit Plan 1.6 bestätigt jede neue Person im Onboarding, mindestens 16 zu sein
(Art. 8 DSGVO), und sieht dabei Nutzungsbedingungen und Datenschutzerklärung.
Die App schickt `ageConfirmed`, `termsVersion` (`TERMS_VERSION`) und
`privacyVersion` (`PRIVACY_UPDATED`, beide aus `CMM/content/legal.ts`) mit
`POST /verify/check`; das Backend speichert `User.consent` mit
`ageConfirmedAt`, `termsVersion`, `privacyVersion`, erneut, sobald sich eine
Version ändert (`routes/verify.js`). Konten von vor Plan 1.6 haben `null`; das
Backend lehnt deshalb keine Anmeldung ab. `GET /me` und der Export liefern
`consent`.

## Verarbeitungsverzeichnis je Collection

Spalten: Zweck · personenbezogene Felder · Rechtsgrundlage (Vorschlag, vom
Anwalt prüfen) · Aufbewahrung (TTL aus dem Modell, sonst "bis Kontolöschung"
oder "keine TTL") · Löschpfad: entfernt `deleteAccount` in `lib/account.js`
die Daten mit dem Konto (ja / nein / n. a. = kein Bezug zu App-Nutzern).

| Collection | Zweck | Personenbezogene Felder | Rechtsgrundlage (vom Anwalt prüfen) | Aufbewahrung / TTL | Löschpfad `lib/account.js` |
|---|---|---|---|---|---|
| `ActiveDay` | Aktive Tage je Person für DAU/WAU/MAU und Retention (`lib/metrics.js`) | `who` (Hash), `day` | Art. 6 Abs. 1 lit. f (Reichweitenmessung ohne Klartext) | TTL 400 Tage (`at`) | nein: Hash bleibt bis zur TTL; prüfen, ob bei Kontolöschung zu entfernen |
| `AdDraft` | Werbevideos des Marketing-Agenten, Freigabe in der Konsole | nur Admin-Daten: `decidedBy`, `edited.by`; keine Nutzerdaten | Art. 6 Abs. 1 lit. f (Betrieb) | keine TTL | n. a. |
| `Admin` | Zugänge zur Admin-Konsole | `email`, `passwordHash`, `totpSecret`, `passkeys` (öffentliche Schlüssel, Gerätename), `invitedBy`, `lastLoginAt`, `lastAckAt`, `failedLogins`, `notify` | Art. 6 Abs. 1 lit. b/f (Beauftragte, Zugangssicherung) | keine TTL; deaktivierte Konten bleiben für den Audit-Trail (`active: false`) | n. a. (Admins, nicht App-Nutzer; Deaktivieren über `DELETE /admin/admins/:id`) |
| `AdminAudit` | Jede Admin-Aktion und jede Einsichtnahme in Personendaten | `admin` (E-Mail), `target` (z. B. Telefonnummer eines Nutzers), `ip`, `meta` | Art. 6 Abs. 1 lit. c/f (Rechenschaftspflicht Art. 5 Abs. 2, Art. 32) | TTL 365 Tage (`at`) | nein, bewusst: Nachweis bleibt bis zur TTL, auch nach Kontolöschung; prüfen |
| `AdminChallenge` | WebAuthn-Challenge beim Passkey-Login (`lib/adminPasskeys.js`) | `admin` (ObjectId) | Art. 6 Abs. 1 lit. f (Zugangssicherung) | TTL 5 Minuten (`createdAt`) | n. a. |
| `AdminPush` | Web-Push-Abos der Admin-Konsole (`AdminPushSubscription`) und das VAPID-Schlüsselpaar (`AdminPushState`) | `admin`, `endpoint`, `keys`, `device` (aus dem User-Agent) | Art. 6 Abs. 1 lit. f (Betrieb) | keine TTL; Abo endet, wenn der Push-Dienst es ablehnt (prüfen) | n. a. |
| `AlertState` | Entprellung der Alarme (`lib/alerts.js`): je Tag letzter Zeitpunkt, Text, Zähler | keine (`lastText` enthält Summen, keine Personen) | – | keine TTL | n. a. |
| `AppConfig` | App-Konfiguration, Limits, Flags, Betriebs-Einstellungen, Migrationen | `updatedBy`, `waitlistLaunch.by` (Admin-E-Mail), `ops.alertPhone` (Telefonnummer des Owners für Alarm-SMS), `ops.emergencyContact` (E-Mail des Notfallkontakts) | Art. 6 Abs. 1 lit. f (Betrieb) | keine TTL | n. a. |
| `BannedNumber` | Sperrliste der Moderation: gesperrte Nummern können sich nicht neu anmelden (`lib/accessGate.js`) | `hash`, `reason`, `by` (Admin-E-Mail) | Art. 6 Abs. 1 lit. f (Schutz anderer Nutzer; muss die Kontolöschung überdauern) | keine TTL | nein, bewusst; Dauer der Sperre prüfen |
| `Block` | Blockierungen zwischen Personen (`lib/relations.js`) | `blocker`, `blocked` (Nummern) | Art. 6 Abs. 1 lit. b/f (Schutzfunktion der App) | keine TTL, bis Kontolöschung | ja (beide Richtungen) |
| `Call` | Ein Anrufversuch: Berechtigung für Agora-Token, Status, Anrufliste | `caller`, `callee` (Nummern), `status`, `video`, Zeitpunkte | Art. 6 Abs. 1 lit. b (Vertrag: Anrufe) | TTL 30 Tage (`createdAt`) | ja |
| `CallMoment` | Moment aus einem echten Gespräch: Bild, Notiz, Stimmung, Reaktionen; geteilt erst nach Zustimmung der anderen Person (`status`) | `userPhone`, `userName`, `targetPhone`, `targetName`, `screenshot` (Bild: Cloudinary-URL oder Data-URI), `note`, `mood`, `reactions.users.phone` | Art. 6 Abs. 1 lit. b; Zustimmung der abgebildeten Person als `status: shared` (lit. a, prüfen) | keine TTL: sichtbar 24 h (`lib/moments.js` VISIBLE_MS), unbeantwortete nach 1 Tag gelöscht (`expirePendingMoments`), geteilte bleiben bis Kontolöschung; prüfen, ob eine TTL nach der Sichtbarkeit reicht | ja: eigene und solche, auf denen die Person zu sehen ist, Reaktionen, Cloudinary-Bilder |
| `Circle` | Gemeinsame Kreise mit Mitgliedern, Einladungen, Ritualen (`lib/circles.js`) | `createdBy`, `members.phone`, `invites.phone`, `invites.hash` (auch Nicht-Nutzer, nur Hash), `invites.invitedBy` | Art. 6 Abs. 1 lit. b; Einladungs-Hashes Nicht-Nutzer: lit. f, prüfen | keine TTL; offene Einladungen ohne Verfall, prüfen | ja: Mitgliedschaft und Einladungen entfernt, leere Kreise gelöscht, Gründerrolle wandert |
| `ClientError` | JavaScript-Fehler der App, gruppiert nach Meldung und Stack; ohne Nutzerbezug (`routes/diagnostics.js`) | keine (prüfen: `message`/`stack` dürfen keine Nummern enthalten) | Art. 6 Abs. 1 lit. f (Fehlerbehebung) | TTL 30 Tage nach `lastAt` | n. a. |
| `DailyMoment` | Yap Moment je Tag und Zeitzone, wer dabei war (`lib/dailyMoment.js`) | `joined`, `fast` (Listen von Nummern) | Art. 6 Abs. 1 lit. b/f (Feature, Badges) | TTL 60 Tage (`at`) | nein: Nummer bleibt bis zur TTL in `joined`/`fast`; prüfen |
| `Invite` | "Ich habe diese Person eingeladen": Verbindung beim Beitritt (`lib/invites.js`) | `from` (Nummer), `toHash` (Hash der Nummer der eingeladenen Person, meist noch kein Nutzer) | Art. 6 Abs. 1 lit. f (Einladung auf Wunsch des Einladenden; Nicht-Nutzer nur als Hash), prüfen | TTL 60 Tage (`createdAt`); eingelöste Einladungen werden beim Beitritt gelöscht | ja (als Einladender und über den eigenen Hash) |
| `InviteVisit` | Besuche des persönlichen Einladungslinks (`/einladung?von=CODE`, `POST /invites/visit`) als Tageszähler je Einladungscode und Plattform (iPhone, Android, andere) | keine (nur Zähler, kein Name, keine IP, kein Cookie; der Code ist `User.inviteCode` des Einladenden und verliert mit dessen Konto seinen Bezug) | – | TTL 400 Tage (`at`) | n. a.: Zähler bleiben bis zur TTL, ohne das Konto sagt der Code nichts mehr |
| `LandingVisit` | Besuche und Funnel-Schritte der Landing-Page als Tageszähler je Quelle und Kampagne | keine (nur Zähler, keine IP, kein Cookie) | – | keine TTL | n. a. |
| `Lock` | Leader-Lease der Hintergrundjobs (`lib/leader.js`), Zeitstempel für `/healthz` | keine (`owner` ist eine Instanz-ID) | – | keine TTL | n. a. |
| `MarketingChannel` | Verbundene Firmenkonten bei Instagram und TikTok, Tokens verschlüsselt (`lib/socialPosting.js`) | `accountId`, `username` (Firmenkonto), `connectedBy` (Admin) | Art. 6 Abs. 1 lit. f (Betrieb) | keine TTL | n. a. |
| `MarketingCharacter` | Referenzbilder der KI-Figuren in Hero-Videos; keine echten Personen | keine | – | keine TTL | n. a. |
| `MarketingSpend` | Kosten je Aufruf des Marketing-Agenten (`lib/marketingBudget.js`) | keine | – | keine TTL | n. a. |
| `MarketingTally` | Tages- und Wochensummen des Marketing-Budgets | `updatedBy` (Admin) | Art. 6 Abs. 1 lit. f (Betrieb) | keine TTL | n. a. |
| `MetricsDaily` | Tages-Snapshot der Kennzahlen (`lib/metrics.js`), nur Summen | keine | – | keine TTL | n. a. |
| `MomentUnlock` | Tage, an denen jemand die Moments der Freunde freigeschaltet hat: Streak und Badges (`lib/unlock.js`) | `phone`, `day`, `via` | Art. 6 Abs. 1 lit. b (Feature) | keine TTL, bis Kontolöschung | ja (seit Plan 1.6b) |
| `Nudge` | "Anna würde gern reden": Anstupser mit Cooldown (`lib/nudges.js`) | `from`, `to` (Nummern), `message` (Plus: eigener Text), `status` | Art. 6 Abs. 1 lit. b | TTL 7 Tage (`createdAt`) | ja |
| `OpsTally` | Betriebszähler je Tag (`lib/opsCounters.js`), nur Summen | keine | – | keine TTL | n. a. |
| `PushDecision` | Was mit jedem Katalog-Push passiert ist (gesendet oder Grund für das Auslassen), für die App und zur Fehlersuche (`lib/notify.js`) | `to`, `about` (Nummern), `type`, `result`, `app` (Zustand der App), `delivery` | Art. 6 Abs. 1 lit. b/f | TTL 3 Tage (`at`) | ja (als Empfänger und als Anlass) |
| `PushLog` | Drosselung sozialer Pushes je Empfänger und Tages-Cap | `to` (Nummer), `key` | Art. 6 Abs. 1 lit. f (Push-Hygiene) | TTL je Eintrag (`expiresAt`, bis 24 h) | ja |
| `PushTicket` | Expo-Push-Tickets, die auf ihre Quittung warten (`lib/receipts.js`) | `token` (Expo-Push-Token des Geräts), `type` | Art. 6 Abs. 1 lit. b/f | TTL 2 Tage (`createdAt`) | ja (über den Push-Token des Nutzers) |
| `Report` | Meldungen von Personen oder Moments, Bearbeitung in der Konsole (`lib/moderation.js`) | `reporter`, `reported` (Nummern), `note`, `momentId`, `resolvedBy` (Admin) | Art. 6 Abs. 1 lit. f (Moderation, Schutz anderer Nutzer) | TTL 180 Tage (`createdAt`) | ja, als Melder und als Gemeldeter; prüfen, ob Meldungen gegen ein gelöschtes Konto als Nachweis bleiben sollten |
| `Room` | Offene Runde eines Kreises: wer wann drin war | `startedBy`, `participants.phone` (Nummern), Zeitpunkte | Art. 6 Abs. 1 lit. b | TTL 30 Tage (`createdAt`) | ja für `participants`; `startedBy` bleibt bis zur TTL, prüfen |
| `SubscriptionEvent` | Jedes Abo-Ereignis, wie RevenueCat es geschickt hat: Grundlage für MRR, Churn, Nachweis der Käufe (`routes/plus.js`) | `userId`, `appUserId` (= unsere User-ID), `transferredFrom`/`transferredTo` (App-User-IDs), Produkt, Preis, Währung, Laufzeit, Kündigungsgrund, Sandbox-Kennzeichen; keine Zahlungsdaten | Art. 6 Abs. 1 lit. b (Vertrag) und lit. c (Aufbewahrung von Buchungsbelegen, § 147 AO / § 257 HGB: 10 Jahre, prüfen) | keine TTL; bleibt nach Kontolöschung als Nachweis | nein, bewusst (Nachweis; die User-ID verweist dann ins Leere); Export: ja (`subscriptions`, `plus`) |
| `SupportTicket` | Hilfe & Feedback aus der App, Antworten aus der Konsole (`routes/support.js`) | `phone`, `messages.text`, `messages.by` (Admin), `app` (Version, Gerät) | Art. 6 Abs. 1 lit. b (Support) | keine TTL, bis Kontolöschung; prüfen, ob geschlossene Tickets eine TTL brauchen | ja |
| `Talk` | Ein beantwortetes und beendetes Gespräch für die persönliche Gesprächszeit-Statistik und Meilensteine | `participants`, `owner` (Nummern), `startedAt`, `seconds`, `circleId` | Art. 6 Abs. 1 lit. b | TTL 400 Tage (`startedAt`) | ja |
| `User` | Das Konto: Identität, Erreichbarkeit, Kontakte, Einstellungen, Meilensteine, Plus, Einwilligung | `phone`, `phoneHash`, `name`, `avatarUrl`, `pushToken`/`voipToken` mit `deviceId` und Plattform, `contacts` und `connections` (Nummern anderer Nutzer), `invitedBy`, `inviteCode` (öffentlicher Code im eigenen Einladungslink; wer ihn kennt, kann über `POST /invites/visit` nur erfahren, dass er vergeben ist, nicht an wen), `locale` (Gerätesprache aus `Accept-Language`, nur zur Messung), `timezone`, `schedule`, `notificationPrefs`, `mood`, `lastOnline`, `isAvailable`, `milestones`, `research`, `consent` (`ageConfirmedAt`, `termsVersion`, `privacyVersion`), `plus`, `plusInterest`, `app` (Version, Gerät), `suspendedUntil`/`suspendReason`, `circles`, `availabilityAudience`, `statsSharing`, `badgeSeen`, `showcase`, `waitlist.code` | Art. 6 Abs. 1 lit. b (Vertrag); Einwilligung und Mindestalter Art. 7/8 (`consent`); Adressbuch-Abgleich (`contacts`, Hash-Verfahren in `routes/contacts.js`): lit. f oder lit. a, prüfen; Moderation (`suspendedUntil`): lit. f | keine TTL, bis Kontolöschung (`DELETE /me`, Konsole) | ja: Konto und jede Spur in anderen Konten (`contacts`, `connections`, `statsSharing.sharedWith`, Kreis-Mitgliedschaften), Avatar bei Cloudinary |
| `WaitlistEntry` | Warteliste der Landing-Page und der Einladungsseite mit Double-Opt-in, Empfehlungen, Einlösen in der App (`lib/waitlist.js`) | `email`, `consent.at`/`ip`/`confirmedIp`/`text` (Nachweis der Einwilligung), `referredBy`, `source`, `campaign` (bei der Einladungsseite `invite-<Code des Einladenden>`), `platform` (iPhone oder Android, aus dem Formular oder dem User-Agent), `claimedBy` (Hash des einlösenden Nutzers) | Art. 6 Abs. 1 lit. a (Einwilligung, Double-Opt-in); Nachweis Art. 7 Abs. 1 | unbestätigte Einträge TTL 7 Tage (`createdAt`, nur `pending`); bestätigte bis zur Abmeldung (der Abmeldelink löscht den Eintrag) | n. a. für das App-Konto: eigener Abmeldelink in jeder Mail; `claimedBy` bleibt nach Kontolöschung als Hash, prüfen |

Bilder (Avatare, Moment-Fotos) liegen bei Cloudinary, nicht in der Datenbank
(ältere Moments als Data-URI in `CallMoment.screenshot`); `deleteAccount`
löscht sie dort mit (`lib/account.js` `deleteImages`, `lib/moments.js`
`deleteMoment`). Audio und Video der Gespräche laufen über Agora und werden
nirgends gespeichert.

## Auftragsverarbeiter

Dienste, die Daten aus diesem Backend verarbeiten, aus README und Code.
**AVV: offen** heißt: Auftragsverarbeitungsvertrag noch nicht abgeschlossen
oder nicht abgelegt; der Owner trägt "vorhanden (Datum, Ablageort)" ein,
sobald er unterschrieben ist (meist in der Konsole des Anbieters, Ablage im
Firmenordner). Sitz und Drittlandtransfer je Anbieter prüfen und in
`legal.ts` beim Abschnitt zur Übermittlung nennen.

| Dienst | Zweck | Daten, die der Dienst sieht | AVV: offen/vorhanden | Hinweis |
|---|---|---|---|---|
| Render | Hosting des Backends (`main`, eine Instanz) | alles im Transit, Server-Logs mit IP-Adressen | offen | Logs: Aufbewahrung bei Render prüfen |
| MongoDB Atlas | Datenbank | alle Collections dieser Datei | offen | Cluster-Region prüfen |
| Twilio | SMS-Verifizierung (`routes/verify.js`), Alarm-SMS an den Owner (`lib/twilio.js`) | Telefonnummer, Zeitpunkt, Ländercode | offen | Twilio Verify speichert Codes und Versuche selbst (Frist prüfen) |
| Agora | Audio- und Videoströme der Anrufe (`lib/agora.js`) | Kanalname, Nutzer-ID im Token, Medienströme (nicht gespeichert) | offen | Aufzeichnung ist nicht aktiviert; prüfen, welche Metadaten Agora behält |
| Cloudinary | Avatare und Moment-Bilder (`app.js`, `lib/moments.js`) | Bilder, Public-ID mit Telefonnummer (`avatars/avatar_<nummer>`) | offen | Public-ID enthält die Nummer: ändern oder im AVV abdecken, prüfen |
| Expo (EAS, Push-Dienst) | Push-Benachrichtigungen (`lib/push.js`), Builds | Expo-Push-Token, Push-Inhalt (Namen, Hinweise) | offen | Quittungen (`lib/receipts.js`) bleiben bei Expo etwa einen Tag |
| Apple | APNs/VoIP-Push (`lib/push.js`), App Store, In-App-Abos | VoIP-Token, Anruf-Push (Nummer des Anrufers), Kaufdaten in Apples Hand | offen (Apple Developer Program License Agreement enthält Datenschutzbestimmungen; prüfen, ob ein eigener AVV nötig ist) | App-Privacy-Label in App Store Connect pflegen (`CMM/docs/RELEASE.md`) |
| RevenueCat | Abo-Ereignisse und -Status (`routes/plus.js`, `lib/revenuecat.js`) | App-User-ID (= unsere User-ID), Produkt, Preis, Währung, Laufzeit, Kündigungsgrund | offen | Webhook mit Secret; `REVENUECAT_API_KEY` für die Abfrage je Nutzer |
| Mailanbieter (`SMTP_URL`) | Wartelisten-, Alarm-, Einladungs- und Dead-Man-Mails (`lib/mailer.js`) | E-Mail-Adressen der Warteliste und der Admins, Mailinhalt | offen | Anbieter in `CMM/content/legal.ts` `MAIL_PROVIDER` eintragen, sobald gewählt |
| Backup-Bucket (Backblaze B2 oder Cloudflare R2) | Wöchentlicher verschlüsselter Dump (`.github/workflows/db-backup.yml`, README "Backup") | der ganze Datenbestand, age-verschlüsselt; nur der Owner hat den Schlüssel | offen | Anbieter beim Einrichten festlegen und hier eintragen |
| GitHub (Actions) | CI (`test.yml`, nur In-Memory-Datenbank, keine Produktionsdaten) und der Backup-Runner | beim Backup: der Dump kurzzeitig im Arbeitsspeicher des Runners, verschlüsselt vor dem Upload | offen | prüfen, ob der Backup-Lauf einen AVV mit GitHub braucht |

Ohne Personenbezug von App-Nutzern, deshalb nicht in der Tabelle: Anthropic
und Google (Veo) für den Marketing-Agenten (Texte und Videos, Budget in
`MarketingSpend`), Instagram und TikTok für das Posten aus Firmenkonten
(`MarketingChannel`), Netlify für die Website (eigene Logs, prüfen).

## Änderungsprozess

Jede neue Datenart bringt ihre Zeile hier, ihren Abschnitt in
`CMM/content/legal.ts`, Speicherdauer, Löschpfad und Test im selben PR mit.
Was jeder Haken bedeutet, steht in `CMM/docs/PRIVACY-CHANGE.md`; die
Kurzfassung ist die Checkliste in `.github/PULL_REQUEST_TEMPLATE.md` dieses
Repos (und die der App). `test/compliance.test.js` hält die erste Tabelle
vollständig: jede Datei in `models/` braucht ihre Zeile, und jede Zeile ein
Modell, das es noch gibt.
