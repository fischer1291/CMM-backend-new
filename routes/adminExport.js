/**
 * The export family of the admin console (plan 2.4): GET
 * /admin/export/:name.csv with name metrics | plus | marketing-spend |
 * support, owners only, every download audited as export_<name>. One CSV
 * dialect for everything (BOM, semicolon, quoted cells, ISO dates), the
 * one GET /admin/waitlist/export (routes/admin.js) started with, so Excel
 * and Numbers open the files without an import dialog. Nothing here carries
 * a phone number or a message text: the plus export names users by their
 * id, the support export counts messages instead of quoting them.
 */
const express = require("express");
const MetricsDaily = require("../models/MetricsDaily");
const SubscriptionEvent = require("../models/SubscriptionEvent");
const MarketingSpend = require("../models/MarketingSpend");
const SupportTicket = require("../models/SupportTicket");
const { requireAdmin, audit } = require("../lib/adminAuth");

const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? "");
const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

/** Rows (arrays of cells) as one CSV text: BOM, semicolons, every cell quoted. */
const toCsv = (rows) => `﻿${rows.map((r) => r.map(cell).join(";")).join("\n")}`;

// Each export: the header and a loader that returns rows in header order
const EXPORTS = {
  metrics: {
    header: [
      "tag", "vorlaeufig", "version",
      "nutzer_gesamt", "nutzer_neu", "dau", "wau", "mau", "aktivierung_4w_pct", "aktivierung_stichprobe",
      "dichte_c3plus_pct", "dichte_c0_pct", "dichte_stichprobe",
      "anrufe", "angenommen", "verpasst", "gespraeche", "gespraechsminuten", "gespraechspersonen",
      "kreise_gesamt", "kreise_neu", "runden", "runden_minuten",
      "moment_dabei", "momente", "anstupser", "einladungen", "ueber_einladung",
      "push_gesendet", "push_fehlgeschlagen", "meldungen_neu", "meldungen_offen",
      "plus_aktiv_store", "plus_aktiv_geschenk", "plus_aktiv_sandbox", "plus_neu", "plus_verlaengert", "plus_gekuendigt",
      "plus_zahlungsproblem", "plus_abgelaufen", "plus_erstattungen", "plus_trials_gestartet", "plus_trials_konvertiert", "mrr_cent",
      "sms_gestartet", "sms_geprueft", "sms_fehlgeschlagen", "reconcile_geprueft", "reconcile_korrigiert",
      "agora_audio_min", "agora_video_min", "cloudinary_uploads", "voip_gesendet", "kosten_variabel_cent", "kosten_je_mau_cent",
      "geschenk_tage_einladung", "geschenk_tage_warteliste", "geschenk_tage_konsole", "geschenk_zu_store",
      "paywall_aufrufe", "kauf_gestartet", "kauf_erfolgreich", "kauf_abgebrochen", "kauf_fehler",
      "wiederherstellen_ok", "wiederherstellen_fehler", "angebot_leer", "limit_treffer",
      "herkunft_freund", "herkunft_tiktok", "herkunft_instagram", "herkunft_flyer", "herkunft_presse", "herkunft_sonstiges", "herkunft_ohne_antwort", "android_freunde_mittel",
    ],
    async rows() {
      const days = await MetricsDaily.find({}, { _id: 0, __v: 0 }).sort({ day: 1 }).lean();
      return days.map((d) => {
        const u = d.users || {}, c = d.calls || {}, t = d.talks || {}, k = d.circles || {}, r = d.rituals || {}, g = d.growth || {}, p = d.push || {}, m = d.reports || {}, x = d.plus || {}, o = d.ops || {}, cost = d.costs || {}, f = x.funnel || {}, src = g.bySource || {};
        return [
          d.day, d.partial ? "ja" : "nein", d.version,
          u.total, u.new, u.dau, u.wau, u.mau, u.activation4w, u.activationSample,
          u.density?.c3plus, u.density?.c0, u.density?.sample,
          c.started, c.answered, c.missed, t.count, t.minutes, t.people,
          k.total, k.new, k.rooms, k.roomMinutes,
          r.dailyJoined, r.moments, r.nudges, g.invites, g.joinedViaInvite,
          p.sent, p.failed, m.new, m.open,
          x.activeStore, x.activeGift, x.activeSandbox, x.newPaid, x.renewed, x.cancelled,
          x.billingIssue, x.expired, x.refunds, x.trialsStarted, x.trialsConverted, x.mrrCents,
          o.smsStarted, o.smsChecked, o.smsFailed, o.plusReconcileChecked, o.plusReconcileFixed,
          cost.agoraAudioMinutes, cost.agoraVideoMinutes, cost.cloudinaryUploads, cost.voipSent, cost.variableEurCents, cost.perMauEurCents,
          x.giftDaysGranted?.referral, x.giftDaysGranted?.waitlist, x.giftDaysGranted?.admin, x.giftToStore,
          // The paywall funnel and the sum of all limit hits (plan 2.6a); per
          // source and per limit they are in the console
          f.paywallView, f.purchaseStart, f.purchaseSuccess, f.purchaseCancel, f.purchaseError,
          f.restoreSuccess, f.restoreError, f.offeringEmpty, x.limitHits ? Object.values(x.limitHits).reduce((a, n) => a + (n || 0), 0) : "",
          // Where the day's sign-ups came from (plan 2.10); per campaign in the console
          src.friend, src.tiktok, src.instagram, src.flyer, src.press, src.other, src.none, g.androidFriendsAvg,
        ];
      });
    },
  },
  plus: {
    header: ["ereignis_id", "zeitpunkt", "typ", "nutzer_id", "produkt", "store", "umgebung", "periode", "preis_usd_cent", "waehrung", "preis_waehrung_cent", "anteil_pct", "kuendigungsgrund", "angebot", "gekauft_am", "laeuft_bis", "ergebnis"],
    async rows() {
      const events = await SubscriptionEvent.find({}, { _id: 0, __v: 0 }).sort({ eventAt: 1, createdAt: 1 }).lean();
      return events.map((e) => [
        e.rcEventId, iso(e.eventAt), e.type, e.userId ? String(e.userId) : "", e.productId, e.store, e.environment, e.periodType,
        e.priceCents, e.currency, e.priceInPurchasedCurrencyCents, e.takehomePercent == null ? "" : Math.round(e.takehomePercent * 100),
        e.cancelReason, e.presentedOfferingId, iso(e.purchasedAt), iso(e.expirationAt), e.result,
      ]);
    },
  },
  "marketing-spend": {
    header: ["id", "tag", "woche", "anbieter", "zweck", "kampagne", "schaetzung_eur", "kosten_eur", "status", "angelegt", "abgerechnet", "notiz"],
    async rows() {
      const spend = await MarketingSpend.find({}).sort({ createdAt: 1 }).lean();
      return spend.map((s) => [String(s._id), s.day, s.week, s.provider, s.purpose, s.campaign, s.estimateEur, s.costEur, s.status, iso(s.createdAt), iso(s.settledAt), s.note]);
    },
  },
  support: {
    header: ["id", "kategorie", "status", "eroeffnet", "aktualisiert", "nachrichten", "von_nutzer", "von_support", "letzte_von", "letzte_am", "app_version", "app_build", "plattform", "os"],
    async rows() {
      const tickets = await SupportTicket.find({}, { phone: 0, "messages.text": 0 }).sort({ createdAt: 1 }).lean();
      return tickets.map((t) => {
        const msgs = t.messages || [];
        const last = msgs[msgs.length - 1];
        return [
          String(t._id), t.category, t.status, iso(t.createdAt), iso(t.updatedAt),
          msgs.length, msgs.filter((m) => m.from === "user").length, msgs.filter((m) => m.from === "support").length,
          last?.from, iso(last?.at), t.app?.version, t.app?.build, t.app?.platform, t.app?.os,
        ];
      });
    },
  },
};

module.exports = () => {
  const router = express.Router();

  // GET /admin/export/metrics.csv | plus.csv | marketing-spend.csv | support.csv
  router.get("/admin/export/:name.csv", requireAdmin("owner"), async (req, res) => {
    const spec = EXPORTS[req.params.name];
    if (!spec) return res.status(404).json({ success: false, error: "unknown_export" });
    try {
      const rows = await spec.rows();
      await audit(req, `export_${req.params.name}`, { meta: { count: rows.length } });
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${req.params.name}-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(toCsv([spec.header, ...rows]));
    } catch (err) {
      console.error(`❌ admin export ${req.params.name}:`, err.message);
      res.status(500).json({ success: false });
    }
  });

  return router;
};

module.exports.EXPORTS = Object.keys(EXPORTS);
module.exports.toCsv = toCsv;
