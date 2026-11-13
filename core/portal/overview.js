// core/portal/overview.js
// Calculs purs (sans réseau) de la page « Mon abonnement » : prochaine livraison, contenu,
// et progression, à partir d'un abonnement Seal relu. Les paliers de fidélité sont dans core/rewards.

const fs = require('fs');
const path = require('path');
const { config, isBoxVariant } = require('../kits/config');

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
  return { id: String(a.id), date: dateOf(a), skipped: isSkipped(a) };
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

module.exports = { loadConfig, isSkipped, nextAttempt, deliveriesCount, progression, contenu, shiftDate, shiftSlot };
