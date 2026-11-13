// core/portal/portalApi.js
// Portail abonné « Mon abonnement » : vue d'ensemble et actions sur la prochaine livraison.
// Module séparé : ne modifie ni le composeur, ni « Mes saveurs », ni le traitement des commandes.
// Changer ses saveurs et sa formule reste dans /kits/subscriptions/... (flavorsApi).

const express = require('express');
const seal = require('../kits/seal');
const { requireCustomer } = require('../kits/customerAuth');
const { withLock } = require('../kits/lock');
const actions = require('./sealPortal');
const ov = require('./overview');
const rewards = require('../rewards/engine');

const router = express.Router();

// Limite simple : 40 requêtes / 10 min par adresse
const hits = new Map();
router.use((req, res, next) => {
  const now = Date.now();
  const arr = (hits.get(req.ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  arr.push(now);
  hits.set(req.ip, arr);
  if (arr.length > 40) return res.status(429).json({ ok: false, error: 'Trop de requêtes, réessaie dans quelques minutes.' });
  return next();
});
router.use(requireCustomer);

/** Même règle que « Mes saveurs » : l'abonnement doit appartenir au client du jeton. */
function owns(sub, who) {
  const email = String(sub.email || sub.customer_email || '').trim().toLowerCase();
  if (!email || email !== who.email) return false;
  const cid = sub.shopify_customer_id;
  return !(cid && String(cid).split('/').pop() !== who.customerId);
}

function view(sub, paquetsParJour) {
  const cfg = ov.loadConfig();
  const next = ov.nextAttempt(sub);
  return {
    id: String(sub.id),
    statut: String(sub.status || '').toUpperCase(),
    // Gamme d'après les variantes : « zero » (saveurs + formule), « rituel » (formule + rituel), « ancienne » (ni l'un ni l'autre)
    gamme: ov.gammeOf(sub),
    formule_mois: ov.formuleMois(sub),
    prochaine_livraison: next,
    pause: ov.pauseOf(sub, next),
    dates_possibles: next && !next.skipped ? ov.dateWindow(next, cfg) : null,
    pause_mois: cfg.pause_mois || [1, 2],
    contenu: ov.contenu(sub),
    progression: ov.progression(sub, Date.now(), cfg, paquetsParJour),
    decalages_jours: cfg.decalages_jours || [7, 15],
    adresse: ov.adresse(sub),
    // Lien Seal propre à cet abonné (modifier adresse, paiement…). Renvoyé seulement à son propriétaire.
    modifier_url: sub.edit_url || null,
  };
}

router.get('/overview', async (req, res) => {
  try {
    const ppj = Number(req.query.paquets_par_jour) || null;
    const list = await seal.findSubscriptionsByEmail(req.customer.email);
    const out = [];
    const fulls = new Map();
    for (const s of list) {
      const full = await seal.getSubscription(s.id);
      fulls.set(String(full.id), full);
      // Abonnements en cours seulement (actifs ou en pause) ; les résiliés ne s'affichent pas
      if (owns(full, req.customer) && /^(ACTIVE|PAUSED)$/i.test(String(full.status || ''))) out.push(view(full, ppj));
    }
    // Un abonnement = une carte, dans l'ordre des prochaines livraisons
    const when = (v) => (v.prochaine_livraison?.date ? Date.parse(v.prochaine_livraison.date) : Infinity);
    out.sort((a, b) => when(a) - when(b));
    // Paliers de fidélité : par client (pas par abonnement). Illisibles → null, la page masque le bloc.
    let fidelite = null;
    if (out.length) {
      try { fidelite = await rewards.statusFor(req.customer.customerId); }
      catch (e) { console.error('[portal] fidélité', e.message); }
    }
    // Boîte offerte au choix : saveur choisie (note de l'abonnement Recharge) ou préférée (son mélange)
    // Le choix est noté sur le premier abonnement des nouvelles gammes (le moteur lit les notes de tous)
    const main = out.find((v) => v.gamme !== 'ancienne');
    if (fidelite) fidelite.abonnement_choix = main ? main.id : null;
    if (fidelite && main) {
      const mainFull = fulls.get(main.id);
      const counts = rewards.flavourCounts(main.contenu.lignes);
      for (const p of fidelite.paliers || []) {
        if (!p.choix?.length) continue;
        const chosen = seal.getNote(mainFull, rewards.choiceNote(p.handle));
        p.choisi = p.choix.some((o) => o.id === chosen) ? chosen : null;
        p.prefere = rewards.pickVariant({ auChoix: true, options: p.choix, produit: null }, { counts })?.id || null;
      }
    }
    // Seal ne donne pas toujours la date de début : on prend alors la 1re commande d'abonnement (Shopify)
    if (fidelite?.depuis) {
      const cfg = ov.loadConfig();
      for (const v of out) {
        if (v.progression.jours !== null) continue;
        const p = ov.progression({ created_at: fidelite.depuis }, Date.now(), cfg, ppj);
        v.progression = { ...v.progression, depuis: p.depuis, jours: p.jours, economies_eur: p.economies_eur };
      }
    }
    return res.json({ ok: true, abonnements: out, fidelite });
  } catch (e) {
    console.error('[portal] overview', e.message, e.seal || '');
    return res.status(502).json({ ok: false, error: 'Impossible de lire ton abonnement pour le moment.' });
  }
});

/** Exécute une action sur un abonnement du client, sous verrou, puis renvoie la vue à jour. */
function act(name, fn) {
  router.post(`/:id/${name}`, async (req, res) => {
    const id = String(req.params.id || '');
    if (!/^\d+$/.test(id)) return res.status(400).json({ ok: false, error: 'Abonnement invalide.' });
    try {
      const result = await withLock(`sub:${id}`, async () => {
        const sub = await seal.getSubscription(id);
        if (!owns(sub, req.customer)) return { status: 404, body: { ok: false, error: 'Abonnement introuvable.' } };
        const refus = await fn(sub, req.body || {});
        if (refus) return { status: 400, body: { ok: false, error: refus } };
        const fresh = await seal.getSubscription(id);
        return { status: 200, body: { ok: true, abonnement: view(fresh) } };
      });
      return res.status(result.status).json(result.body);
    } catch (e) {
      console.error(`[portal] ${name}`, id, e.message, e.seal || '');
      return res.status(502).json({ ok: false, error: "Ça n'a pas pu être enregistré. Réessaie dans un instant, rien n'a changé." });
    }
  });
}

const active = (sub) => /^ACTIVE$/i.test(String(sub.status || ''));

/** Efface la pause « maison » quand la date est changée autrement (sinon l'affichage serait faux). */
async function clearPause(sub) {
  if (seal.getNote(sub, ov.PAUSE_NOTE)) await seal.upsertNotes(sub.id, [{ name: ov.PAUSE_NOTE, value: '' }]);
}

/** Prochaine livraison modifiable (active, pas sautée) ou message de refus. */
function movable(sub) {
  if (!active(sub)) return { refus: "L'abonnement n'est pas actif." };
  const next = ov.nextAttempt(sub);
  if (!next?.id) return { refus: 'Aucune livraison à modifier.' };
  if (next.skipped) return { refus: 'Cette livraison est sautée : reprends-la d\'abord.' };
  return { next };
}

/**
 * Nouvelle date pour la prochaine livraison ; les suivantes repartent de cette date (reset_schedule).
 * Toujours dans la fenêtre autorisée : au plus tôt dans 2 jours, au plus tard 29 jours après la date prévue.
 */
async function moveTo(sub, next, dateStr) {
  const win = ov.dateWindow(next);
  if (!win || dateStr < win.min || dateStr > win.max) return 'Cette date n\'est pas possible.';
  const slot = ov.slotOn(next.date, dateStr);
  await actions.reschedule(sub.id, next.id, slot.date, slot.time, slot.timezone, true);
  return null;
}

// Raccourcis +7 / +15 jours
act('decaler', async (sub, body) => {
  const days = Number(body.jours);
  if (!(ov.loadConfig().decalages_jours || []).includes(days)) return 'Décalage non proposé.';
  const { next, refus } = movable(sub);
  if (refus) return refus;
  const r = await moveTo(sub, next, ov.addDays(ov.dayOf(next.date), days));
  if (!r) await clearPause(sub);
  return r;
});

// Date choisie dans le calendrier
act('date', async (sub, body) => {
  const dateStr = String(body.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return 'Date invalide.';
  const { next, refus } = movable(sub);
  if (refus) return refus;
  const r = await moveTo(sub, next, dateStr);
  if (!r) await clearPause(sub);
  return r;
});

act('sauter', async (sub) => {
  const next = ov.nextAttempt(sub);
  if (!active(sub) || !next?.id) return 'Aucune livraison à sauter.';
  if (next.skipped) return 'Cette livraison est déjà sautée.';
  await actions.skip(sub.id, next.id);
  return null;
});

act('reprendre-livraison', async (sub) => {
  const next = ov.nextAttempt(sub);
  if (!next?.id || !next.skipped) return "Cette livraison n'est pas sautée.";
  await actions.unskip(sub.id, next.id);
  return null;
});

act('recevoir-maintenant', async (sub) => {
  const next = ov.nextAttempt(sub);
  if (!active(sub) || !next?.id || next.skipped) return 'Aucune livraison à avancer.';
  await actions.processNow(sub.id, next.id);
  return null;
});

act('cadeau', async (sub, body) => {
  const tiers = await rewards.loadTiers();
  const tier = (tiers || []).find((t) => t.handle === String(body.palier || '') && t.auChoix);
  if (!tier) return 'Ce cadeau ne se choisit pas.';
  const option = tier.options.find((o) => o.id === String(body.variante || ''));
  if (!option) return 'Saveur inconnue.';
  await seal.upsertNotes(sub.id, [{ name: rewards.choiceNote(tier.handle), value: option.id }]);
  return null;
});

// Pause 1 ou 2 mois : la prochaine livraison est repoussée d'autant (les suivantes repartent de là).
// Dans Seal l'abonnement reste actif : il reprend tout seul, sans rien à relancer.
act('pause', async (sub, body) => {
  const mois = Number(body.mois);
  if (!(ov.loadConfig().pause_mois || [1, 2]).includes(mois)) return 'Durée de pause non proposée.';
  const { next, refus } = movable(sub);
  if (refus) return refus;
  const depuis = ov.dayOf(next.date);
  const jusqu = ov.addMonths(depuis, mois);
  const slot = ov.slotOn(next.date, jusqu);
  await actions.reschedule(sub.id, next.id, slot.date, slot.time, slot.timezone, true);
  await seal.upsertNotes(sub.id, [{ name: ov.PAUSE_NOTE, value: `${depuis}|${jusqu}` }]);
  return null;
});

// Reprendre plus tôt : retour à la date d'origine (ou au plus tôt possible si elle est passée)
act('fin-pause', async (sub) => {
  const { next, refus } = movable(sub);
  if (refus) return refus;
  const pause = ov.pauseOf(sub, next);
  if (!pause) return "L'abonnement n'est pas en pause.";
  const earliest = ov.addDays(ov.parisToday(), ov.loadConfig().report?.min_jours ?? 2);
  const dateStr = pause.depuis && pause.depuis >= earliest ? pause.depuis : earliest;
  const slot = ov.slotOn(next.date, dateStr);
  await actions.reschedule(sub.id, next.id, slot.date, slot.time, slot.timezone, true);
  await clearPause(sub);
  return null;
});

// Abonnement mis en pause dans Seal (anciennes pauses) : reprise à la demande du client, jamais automatique
act('reprendre', async (sub) => {
  if (!/^PAUSED$/i.test(String(sub.status || ''))) return "L'abonnement n'est pas en pause.";
  await actions.resume(sub.id);
  return null;
});

module.exports = router;
