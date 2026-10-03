## Was ändert sich?

<!-- Ein, zwei Sätze: was und warum. Plan-Punkt aus CMM/docs/SCALE-PLAN.md nennen, wenn es einen gibt. -->

## Checkliste

- [ ] `npm test` grün; neue Routen und Jobs haben einen Test neben denen ihres Moduls
- [ ] Neue Env-Variablen in der README-Tabelle, neue Konsolen-Einstellungen in der README
- [ ] Neue Collection oder neue personenbezogene Felder: Zeile in `COMPLIANCE.md` (der CI-Test `test/compliance.test.js` prüft jede Datei in `models/`)
- [ ] Löschpfad: `lib/account.js` löscht und exportiert die neuen Daten, oder `COMPLIANCE.md` sagt, warum sie bleiben
- [ ] Speicherdauer: TTL-Index im Modell oder Aufräumjob in `index.js`
- [ ] Datenfixes nur in `migrate()` in `index.js`, idempotent
- [ ] Admin-Konsole (`admin-ui/app.js`) angepasst, wenn die Konsole die Daten zeigt oder einstellt
- [ ] Deploy-Fenster beachtet: nie ±15 Minuten um den Yap Moment (`CMM/docs/RUNBOOK.md`)

Was die Datenschutz-Haken bedeuten, steht in `CMM/docs/PRIVACY-CHANGE.md`.
