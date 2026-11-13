// core/portal/overview.js
// Calculs purs (sans réseau) de la page « Mon abonnement » : prochaine livraison, contenu,
// et progression, à partir d'un abonnement Seal relu. Les paliers de fidélité sont dans core/rewards.

const fs = require('fs');
const path = require('path');

function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
}

const DAY = 86400000;
const dateOf = (a) => a?.date || a?.billing_date || a?.scheduled_at || a?.billing_attempt_date || null;
const isDone = (a) => !!(a?.order_id || a?.completed_at) || /^(completed|processed|success|paid)$/i.test(String(a?.status || ''));
const isSkipped = (a) => /skip/i.test(String(a?.status || '')) || a?.skipped === true || a?.skipped === 1;

/** Prochaine échéance non traitée (sautée ou non), la plus proche. */
function nextAttempt(sub) {
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
  if (jours !== null && ppj > 0) out.economies_eur = Math.round(jours * ppj * Number(cfg.progression?.prix_paquet_eur || 0));
  return out;
}

/** Contenu de la prochaine livraison : lignes de l'abonnement (boîtes à 0 € comprises). */
function contenu(sub) {
  const items = (sub.items || []).map((it) => ({
    titre: it.title || it.product_title || '',
    variante: it.variant_title || '',
    quantite: Number(it.quantity || 0),
    prix: Number(it.price || 0),
  }));
  const total = items.reduce((s, it) => s + it.prix * it.quantite, 0);
  return { lignes: items.filter((i) => i.quantite > 0), total: Math.round(total * 100) / 100 };
}

/** Nouvelle date = date prévue + n jours (format AAAA-MM-JJ). */
function shiftDate(iso, days) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + Number(days) * DAY).toISOString().slice(0, 10);
}

module.exports = { loadConfig, nextAttempt, deliveriesCount, progression, contenu, shiftDate };
