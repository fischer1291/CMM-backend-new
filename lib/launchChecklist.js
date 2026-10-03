/**
 * The launch gate (plan 2.7): one checklist that must be complete before the
 * first euro of paid reach. Manual ticks are set by an owner in the console
 * (AppConfig.launchChecklist, PUT /admin/launch-checklist/:key); automatic
 * ticks are computed on every read from what the backend already knows
 * (/healthz, the restore drill, owners with TOTP, the last backup, the last
 * pentest). lib/marketingBudget.js refuses "media" reservations while the
 * list is incomplete; the phase gate tile of plan 3.1 reads the same status.
 */
const AppConfig = require("../models/AppConfig");
const Admin = require("../models/Admin");
const { getConfig } = require("./appConfig");

const DAY = 24 * 3600 * 1000;
// How fresh each dated proof must be
const RESTORE_DRILL_DAYS = 90;
const BACKUP_DAYS = 8;
const PENTEST_DAYS = 365;
const MIN_OWNERS = 2;
const MAX_NOTE = 300;

const fmt = (d) => new Date(d).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin", day: "numeric", month: "long", year: "numeric" });
const fresh = (at, days, now) => !!at && !isNaN(new Date(at)) && now - new Date(at) < days * DAY;

/** A dated proof from AppConfig.ops: done while younger than `days`. */
const dated = (field, days, what, where) => async ({ ops, now }) => {
  const at = ops[field] ? new Date(ops[field]) : null;
  if (!at || isNaN(at)) return { done: false, at: null, detail: `Noch kein ${what} eingetragen (${where}).` };
  const done = fresh(at, days, now);
  return { done, at, detail: done ? `${what} am ${fmt(at)}` : `${what} am ${fmt(at)}, älter als ${days} Tage` };
};

// In display order: what the backend proves itself, then what the owner ticks
const AUTO = {
  healthz: {
    label: "/healthz antwortet",
    async check({ health }) {
      const h = await health().catch(() => ({ ok: false, reason: "error" }));
      return { done: !!h.ok, at: null, detail: h.ok ? "Datenbank verbunden, Jobs laufen" : `/healthz meldet: ${h.reason || "Fehler"}` };
    },
  },
  restoreDrill: {
    label: `Restore-Test jünger als ${RESTORE_DRILL_DAYS} Tage`,
    check: dated("lastRestoreDrillAt", RESTORE_DRILL_DAYS, "Restore-Test", "App → Betrieb"),
  },
  backupFresh: {
    label: `Backup jünger als ${BACKUP_DAYS} Tage`,
    check: dated("lastBackupAt", BACKUP_DAYS, "Backup", "meldet die DB-Backup-Action"),
  },
  twoOwners: {
    label: `Mindestens ${MIN_OWNERS} aktive Owner mit Authenticator`,
    async check() {
      const n = await Admin.countDocuments({ role: "owner", totpEnabled: true, active: { $ne: false } });
      return { done: n >= MIN_OWNERS, at: null, detail: `${n} aktive${n === 1 ? "r" : ""} Owner mit Authenticator` };
    },
  },
  pentest: {
    label: `Pentest jünger als ${PENTEST_DAYS} Tage`,
    check: dated("lastPentestAt", PENTEST_DAYS, "Pentest", "App → Betrieb"),
  },
};

// Manual ticks: the label and, as detail, what counts as done
const MANUAL = {
  gewerbe: ["Gewerbe angemeldet", "Gewerbeanmeldung beim Gewerbeamt, Bestätigung abgelegt."],
  bankAccount: ["Geschäftskonto", "Eigenes Konto für Einnahmen (Apple) und Ausgaben."],
  taxAdvisor: ["Steuerberatung", "Steuerberatung beauftragt oder bewusst selbst gemacht (Notiz)."],
  branchProtection: ["Branch-Schutz", "GitHub: main in beiden Repos geschützt (Review oder Checks vor dem Merge)."],
  insurance: ["Versicherung", "IT-Haftpflicht/Cyber abgeschlossen (Deckung in der Notiz)."],
  traderStatus: ["Trader-Status (DSA)", "App Store Connect → Business: Händlerstatus angegeben, Kontaktdaten stimmen."],
  trademark: ["Marke", "DPMA-Anmeldung eingereicht oder nach Recherche bewusst verschoben (Notiz)."],
  ageRating: ["Altersfreigabe", "Fragebogen in App Store Connect beantwortet (Mindestalter 16 in den Nutzungsbedingungen)."],
  privacyLabel: ["App-Privacy-Label", "Datenschutzangaben in App Store Connect passen zu COMPLIANCE.md."],
  dpaSigned: ["AV-Verträge", "Auftragsverarbeitungsverträge aller Dienste abgeschlossen (CMM/docs/COMPLIANCE.md)."],
  lawyerReview: ["Anwaltliche Prüfung", "Nutzungsbedingungen, Datenschutzerklärung und Impressum geprüft."],
};

const KEYS = [...Object.keys(AUTO), ...Object.keys(MANUAL)];

/**
 * { complete, items: [{ key, label, kind, done, at, by, note, detail }] }.
 * `health` is injectable for tests (default: lib/health.js healthStatus).
 */
async function status(now = new Date(), { health = () => require("./health").healthStatus({ now }) } = {}) {
  const [config, stored] = await Promise.all([getConfig(), AppConfig.findOne({ key: "app" }, { launchChecklist: 1 }).lean()]);
  const ticks = stored?.launchChecklist || {};
  const items = [];
  for (const [key, spec] of Object.entries(AUTO)) {
    const r = await spec.check({ ops: config.ops, now, health });
    items.push({ key, label: spec.label, kind: "auto", done: r.done, at: r.at, by: null, note: null, detail: r.detail });
  }
  for (const [key, [label, detail]] of Object.entries(MANUAL)) {
    const t = ticks[key] || {};
    items.push({ key, label, kind: "manual", done: t.done === true, at: t.at || null, by: t.by || null, note: t.note || null, detail });
  }
  return { complete: items.every((i) => i.done), items };
}

/** Is the gate open? (For lib/marketingBudget.js; never throws.) */
async function complete(now = new Date()) {
  try {
    return (await status(now)).complete;
  } catch (err) {
    console.error("❌ launch checklist:", err.message);
    return false;
  }
}

/** An owner ticks or unticks a manual item. Returns { item } or { error }. */
async function setManual(key, { done, note } = {}, by, now = new Date()) {
  if (!Object.hasOwn(MANUAL, key)) return { error: Object.hasOwn(AUTO, key) ? "automatic_item" : "unknown_item" };
  if (typeof done !== "boolean") return { error: "invalid_item" };
  if (note != null && (typeof note !== "string" || note.trim().length > MAX_NOTE)) return { error: "invalid_item" };
  const item = { done, at: now, by, note: note ? note.trim() : null };
  // A stored null (or no field) cannot take a dotted $set: make it an object
  // first, then set only this key, so two owners ticking at once both count
  await AppConfig.updateOne({ key: "app", launchChecklist: null }, { $set: { launchChecklist: {} } });
  const write = () => AppConfig.updateOne({ key: "app" }, { $set: { [`launchChecklist.${key}`]: item } }, { upsert: true });
  try {
    await write();
  } catch (err) {
    // Two first ticks without a config document: one upsert wins, the other
    // hits the unique key and simply updates the document now there
    if (err?.code !== 11000) throw err;
    await write();
  }
  return { item };
}

module.exports = { status, complete, setManual, KEYS, AUTO_KEYS: Object.keys(AUTO), MANUAL_KEYS: Object.keys(MANUAL), RESTORE_DRILL_DAYS, BACKUP_DAYS, PENTEST_DAYS, MIN_OWNERS };
