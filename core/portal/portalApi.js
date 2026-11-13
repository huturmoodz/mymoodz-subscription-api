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
  return {
    id: String(sub.id),
    statut: String(sub.status || '').toUpperCase(),
    prochaine_livraison: ov.nextAttempt(sub),
    contenu: ov.contenu(sub),
    progression: ov.progression(sub, Date.now(), cfg, paquetsParJour),
    decalages_jours: cfg.decalages_jours || [7, 15],
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
    // Recharge ZÉRO en premier (c'est elle qui porte les saveurs et les paliers)
    out.sort((a, b) => Number(isRecharge(b)) - Number(isRecharge(a)));
    // Paliers de fidélité : par client (pas par abonnement). Illisibles → null, la page masque le bloc.
    let fidelite = null;
    if (out.length) {
      try { fidelite = await rewards.statusFor(req.customer.customerId); }
      catch (e) { console.error('[portal] fidélité', e.message); }
    }
    // Boîte offerte au choix : saveur choisie (note de l'abonnement Recharge) ou préférée (son mélange)
    if (fidelite && out[0]) {
      const mainFull = fulls.get(out[0].id);
      const counts = rewards.flavourCounts(out[0].contenu.lignes);
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

const isRecharge = (v) => (v.contenu?.lignes || []).some((l) => /recharge/i.test(l.titre));
const active = (sub) => /^ACTIVE$/i.test(String(sub.status || ''));

act('decaler', async (sub, body) => {
  const days = Number(body.jours);
  if (!(ov.loadConfig().decalages_jours || []).includes(days)) return 'Décalage non proposé.';
  if (!active(sub)) return "L'abonnement n'est pas actif.";
  const next = ov.nextAttempt(sub);
  if (!next?.id) return 'Aucune livraison à décaler.';
  const date = ov.shiftDate(next.date, days);
  if (!date) return 'Date de livraison illisible.';
  await actions.reschedule(sub.id, next.id, date);
  return null;
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

act('pause', async (sub) => {
  if (!active(sub)) return "L'abonnement n'est pas actif.";
  await actions.pause(sub.id);
  return null;
});

act('reprendre', async (sub) => {
  if (!/^PAUSED$/i.test(String(sub.status || ''))) return "L'abonnement n'est pas en pause.";
  await actions.resume(sub.id);
  return null;
});

module.exports = router;
