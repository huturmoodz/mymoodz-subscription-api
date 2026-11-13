// core/portal/overview.js
// Calculs purs (sans réseau) de la page « Mon abonnement » : prochaine livraison, contenu,
// et progression, à partir d'un abonnement Seal relu. Les paliers de fidélité sont dans core/rewards.

const fs = require('fs');
const path = require('path');
const { config, isBoxVariant, rangeOf, monthsOf, rituelOf } = require('../kits/config');

function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
}

const DAY = 86400000;
const dateOf = (a) => a?.date || a?.billing_date || a?.scheduled_at || a?.billing_attempt_date || null;
const isDone = (a) => !!(a?.order_id || a?.completed_at) || /^(completed|processed|success|paid)$/i.test(String(a?.status || ''));
// Échéance sautée : Seal ne documente pas comment il la renvoie (constaté le 13/11 : sautée dans
// Seal, mais ni « status: skipped » ni « skipped: true »). On accepte toutes les formes plausibles :
// un statut qui contient « skip », ou tout champ dont le nom contient « skip » avec une valeur vraie
// (true, 1, "1", "true", "yes") ou une date (ex. skipped_at).
const truthy = (v) => v === true || v === 1
  || /^(1|true|yes|y)$/i.test(String(v ?? '').trim())
  || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v));
const isSkipped = (a) => /skip/i.test(String(a?.status || ''))
  || Object.keys(a || {}).some((k) => /skip/i.test(k) && truthy(a[k]));

// Une seule fois par démarrage : la forme réelle des échéances Seal dans les logs (aucune donnée client).
let shapeLogged = false;
function logAttemptShape(sub) {
  if (shapeLogged) return;
  const open = (sub.billing_attempts || []).filter((a) => !isDone(a)).slice(0, 2);
  if (!open.length) return;
  shapeLogged = true;
  console.log('[portal] forme des échéances Seal', JSON.stringify(open));
}

/** Prochaine échéance non traitée (sautée ou non), la plus proche. */
function nextAttempt(sub) {
  logAttemptShape(sub);
  const list = (sub.billing_attempts || [])
    .filter((a) => !isDone(a) && dateOf(a))
    .sort((a, b) => new Date(dateOf(a)) - new Date(dateOf(b)));
  const a = list[0];
  if (!a) return sub.next_billing_date ? { id: null, date: sub.next_billing_date, skipped: false } : null;
  const out = { id: String(a.id), date: dateOf(a), skipped: isSkipped(a) };
  // Livraison sautée : la vraie prochaine livraison (la première suivante non sautée), pour l'afficher
  if (out.skipped) {
    const real = list.find((x) => !isSkipped(x));
    out.suivante = real ? dateOf(real) : null;
  }
  return out;
}

/** Adresse de livraison de l'abonnement (champs s_* de Seal), ou null si absente. */
function adresse(sub) {
  const v = (k) => String(sub?.[k] ?? '').trim();
  if (!v('s_address1')) return null;
  return {
    nom: [v('s_first_name'), v('s_last_name')].filter(Boolean).join(' '),
    lignes: [v('s_company'), v('s_address1'), v('s_address2')].filter(Boolean),
    ville: [v('s_zip'), v('s_city')].filter(Boolean).join(' '),
    pays: v('s_country'),
  };
}

/** Livraisons reçues = commande d'origine + renouvellements traités. */
function deliveriesCount(sub) {
  return 1 + (sub.billing_attempts || []).filter(isDone).length;
}

function progression(sub, now = Date.now(), cfg = loadConfig(), paquetsParJour = null) {
  const start = sub.created_at ? new Date(sub.created_at).getTime() : null;
  const jours = start ? Math.max(0, Math.floor((now - start) / DAY)) : null;
  const out = { depuis: sub.created_at || null, jours, livraisons: deliveriesCount(sub), economies_eur: null };
  const ppj = Number(paquetsParJour);
  out.prix_paquet_eur = Number(cfg.progression?.prix_paquet_eur || 0);   // la page recalcule sans recharger
  if (jours !== null && ppj > 0) out.economies_eur = Math.round(jours * ppj * out.prix_paquet_eur);
  return out;
}

/** Contenu de la prochaine livraison : lignes de l'abonnement (boîtes à 0 € comprises). */
function contenu(sub) {
  const items = (sub.items || []).map((it) => {
    const vid = String(it.variant_id || '');
    // Boîtes : nom de saveur actuel (Seal garde l'ancien titre, ex. « Menthe Poivrée »)
    const box = isBoxVariant(vid) ? config.boxes[vid] : null;
    return {
      titre: box ? 'Boîte ZÉRO' : (it.title || it.product_title || ''),
      variante: box ? box.label : (it.variant_title || ''),
      quantite: Number(it.quantity || 0),
      prix: Number(it.price || 0),
      variant_id: vid,
    };
  });
  const total = items.reduce((s, it) => s + it.prix * it.quantite, 0);
  return { lignes: items.filter((i) => i.quantite > 0), total: Math.round(total * 100) / 100 };
}

/** Nouvelle date = date prévue + n jours (format AAAA-MM-JJ). */
function shiftDate(iso, days) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + Number(days) * DAY).toISOString().slice(0, 10);
}

/**
 * Nouveau créneau pour Seal (date + heure + fuseau) : Seal refuse un report sans heure
 * (« Time is missing », constaté le 13/11). On garde l'heure prévue de l'échéance, en UTC.
 */
function shiftSlot(iso, days) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const n = new Date(d.getTime() + Number(days) * DAY);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(iso).trim());
  return { date: n.toISOString().slice(0, 10), time: dateOnly ? '12:00' : n.toISOString().slice(11, 16), timezone: '+00:00' };
}

/* ---------- Gamme de l'abonnement ---------- */

/**
 * Gamme de l'abonnement, d'après les identifiants de variantes (jamais d'après les titres) :
 * « zero » s'il contient une Recharge ZÉRO Saveurs, sinon « rituel » s'il contient une recharge RITUEL,
 * sinon « ancienne » (ancienne gamme : pas de saveurs ni de formule en libre-service).
 */
function gammeOf(sub) {
  const ranges = (sub.items || []).filter((it) => Number(it.quantity || 0) > 0 && !isBoxVariant(it.variant_id))
    .map((it) => rangeOf(it.variant_id));
  if (ranges.includes('zero')) return 'zero';
  if (ranges.includes('rituel')) return 'rituel';
  return 'ancienne';
}

/** Durée (en mois) de la formule d'un abonnement ZÉRO Saveurs ou RITUEL ; null pour l'ancienne gamme. */
function formuleMois(sub) {
  for (const it of sub.items || []) {
    if (Number(it.quantity || 0) <= 0) continue;
    if (rangeOf(it.variant_id) === 'zero') return monthsOf(it.variant_id);
    const r = rituelOf(it.variant_id);
    if (r) return r.months;
  }
  return null;
}

/* ---------- Dates : calendrier et pause ---------- */

const ymd = (d) => d.toISOString().slice(0, 10);
/** Date du jour à Paris (AAAA-MM-JJ). */
const parisToday = (now = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
const addDays = (dateStr, n) => ymd(new Date(Date.parse(`${dateStr}T12:00:00Z`) + Number(n) * DAY));
/** + n mois calendaires, même jour (ramené à la fin du mois si besoin : 31 janv. + 1 mois = 28/29 févr.). */
function addMonths(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + Number(n), 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return ymd(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))));
}
const dayOf = (iso) => String(iso || '').slice(0, 10);

/**
 * Dates qu'un abonné peut choisir pour sa prochaine livraison :
 * au plus tôt dans « min » jours, au plus tard « max » jours après la date prévue. Au-delà : la pause.
 */
function dateWindow(next, cfg = loadConfig(), now = Date.now()) {
  if (!next?.date) return null;
  const min = addDays(parisToday(now), cfg.report?.min_jours ?? 2);
  const max = addDays(dayOf(next.date), cfg.report?.max_jours ?? 29);
  return min <= max ? { min, max } : null;
}

/** Créneau Seal pour une date donnée, en gardant l'heure prévue de l'échéance (UTC). */
function slotOn(iso, dateStr) {
  const d = new Date(iso);
  const time = Number.isNaN(d.getTime()) || /^\d{4}-\d{2}-\d{2}$/.test(String(iso).trim()) ? '12:00' : d.toISOString().slice(11, 16);
  return { date: dateStr, time, timezone: '+00:00' };
}

/** Pause « maison » (report de la prochaine livraison) : note Seal « date d'origine|date de reprise ». */
const PAUSE_NOTE = 'mmz_pause';
function pauseOf(sub, next) {
  const raw = String((sub.note_attributes || []).find((a) => a.name === PAUSE_NOTE)?.value || '');
  const [depuis, jusqu] = raw.split('|');
  if (!jusqu || !next?.date || next.skipped || dayOf(next.date) !== jusqu) return null;
  return { depuis, jusqu_au: jusqu };
}

module.exports = {
  loadConfig, isSkipped, adresse, nextAttempt, deliveriesCount, progression, contenu, shiftDate, shiftSlot,
  gammeOf, formuleMois, parisToday, addDays, addMonths, dateWindow, slotOn, dayOf, PAUSE_NOTE, pauseOf,
};
