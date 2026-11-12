// core/kits/flavorsApi.js
// BRIQUE B — « Mes saveurs » : le client connecté consulte et modifie la répartition des boîtes
// de son abonnement pour la prochaine livraison (une seule saveur, ou un mix).
// Le nombre total de boîtes est imposé par sa formule (1 mois = 4, 2 mois = 8, 3 mois = 12).

const express = require('express');
const { config, monthsOf, isParentVariant } = require('./config');
const { validateComposition, totalOf } = require('./composition');
const seal = require('./seal');
const { analyse, storedPerUnit, applyToSubscription } = require('./subscriptionKit');
const { requireCustomer } = require('./customerAuth');
const { withLock } = require('./lock');
const { changeFormula, formulaOptions, FormulaError } = require('./formula');

const router = express.Router();

// Limite simple : 30 requêtes / 10 min par client
const hits = new Map();
router.use((req, res, next) => {
  const key = req.ip;
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < 10 * 60 * 1000);
  arr.push(now);
  hits.set(key, arr);
  if (arr.length > 30) return res.status(429).json({ ok: false, error: 'Trop de requêtes, réessayez dans quelques minutes.' });
  return next();
});

router.use(requireCustomer);

/** L'abonnement appartient-il bien au client du jeton ? */
function owns(sub, who) {
  const email = String(sub.email || sub.customer_email || '').trim().toLowerCase();
  if (!email || email !== who.email) return false;
  // Seal peut exposer l'identifiant client Shopify : s'il est présent, il doit aussi correspondre.
  const cid = sub.shopify_customer_id;
  if (cid && String(cid).split('/').pop() !== who.customerId) return false;
  return true;
}

function view(sub) {
  const { parents } = analyse(sub);
  const parent = parents[0];
  const perUnit = storedPerUnit(sub, parent) || new Map();
  const qty = parents.reduce((s, p) => s + Number(p.quantity || 0), 0);
  return {
    id: sub.id,
    status: sub.status,
    next_billing_date: sub.next_billing_date || sub.next_order_date || null,
    formula: { variantId: String(parent.variant_id), months: monthsOf(parent.variant_id), quantity: qty },
    target: monthsOf(parent.variant_id) * config.boxesPerMonth,
    composition: Object.fromEntries(perUnit),
    flavors: Object.entries(config.boxes).map(([variantId, b]) => ({ variantId, code: b.code, label: b.label })),
    formulas: formulaOptions(parent.variant_id),
  };
}

router.get('/subscriptions', async (req, res) => {
  try {
    const subs = await seal.findSubscriptionsByEmail(req.customer.email);
    const mine = [];
    for (const s of subs) {
      // La liste ne contient pas toujours tout : on relit chaque abonnement en détail
      const full = await seal.getSubscription(s.id);
      if (!owns(full, req.customer)) continue;
      if (!analyse(full).parents.length) continue;
      mine.push(view(full));
    }
    return res.json({ ok: true, subscriptions: mine });
  } catch (e) {
    console.error('[kits/flavors] liste', e.message, e.seal || '');
    return res.status(502).json({ ok: false, error: 'Impossible de lire vos abonnements pour le moment.' });
  }
});

router.post('/subscriptions/:id/composition', async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^\d+$/.test(id)) return res.status(400).json({ ok: false, error: 'Abonnement invalide.' });
  try {
    const result = await withLock(`sub:${id}`, async () => {
      const sub = await seal.getSubscription(id);
      if (!owns(sub, req.customer)) return { status: 404, body: { ok: false, error: 'Abonnement introuvable.' } };
      const { parents } = analyse(sub);
      if (!parents.length) return { status: 400, body: { ok: false, error: 'Cet abonnement ne contient pas de recharge à composer.' } };

      const target = monthsOf(parents[0].variant_id) * config.boxesPerMonth;
      const map = new Map();
      for (const [variantId, q] of Object.entries(req.body?.composition || {})) {
        const n = Number(q);
        if (!Number.isInteger(n) || n < 0 || n > target) {
          return { status: 400, body: { ok: false, error: 'Quantité invalide.' } };
        }
        if (n > 0) map.set(String(variantId), n);
      }
      const check = validateComposition(map, target);
      if (!check.ok) {
        return { status: 400, body: { ok: false, error: `Choisissez exactement ${target} boîtes (actuellement ${totalOf(map)}).` } };
      }
      await applyToSubscription(sub, check.map);
      const fresh = await seal.getSubscription(id);
      return { status: 200, body: { ok: true, subscription: view(fresh) } };
    });
    return res.status(result.status).json(result.body);
  } catch (e) {
    console.error('[kits/flavors] modification', id, e.message, e.seal || '');
    return res.status(502).json({ ok: false, error: "La modification n'a pas pu être enregistrée. Réessayez dans un instant." });
  }
});

// Changer de formule (1, 2 ou 3 mois) : fréquence, ligne Recharge et nombre de boîtes, mélange gardé.
router.post('/subscriptions/:id/formula', async (req, res) => {
  const id = String(req.params.id || '');
  const variantId = String(req.body?.variantId || '');
  if (!/^\d+$/.test(id)) return res.status(400).json({ ok: false, error: 'Abonnement invalide.' });
  if (!isParentVariant(variantId)) return res.status(400).json({ ok: false, error: 'Formule invalide.' });
  try {
    const result = await withLock(`sub:${id}`, async () => {
      const sub = await seal.getSubscription(id);
      if (!owns(sub, req.customer)) return { status: 404, body: { ok: false, error: 'Abonnement introuvable.' } };
      const r = await changeFormula(sub, variantId);
      const fresh = await seal.getSubscription(id);
      console.log('[kits/flavors] formule', id, r);
      return { status: 200, body: { ok: true, result: r, subscription: view(fresh) } };
    });
    return res.status(result.status).json(result.body);
  } catch (e) {
    if (e instanceof FormulaError) return res.status(400).json({ ok: false, error: e.message });
    console.error('[kits/flavors] formule', id, e.message, e.seal || '');
    return res.status(502).json({ ok: false, error: "Le changement de formule n'a pas pu être enregistré. Réessaie dans un instant, rien n'a été modifié." });
  }
});

module.exports = router;
