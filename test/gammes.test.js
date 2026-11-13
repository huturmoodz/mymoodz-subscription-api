// Gammes (ZÉRO Saveurs / RITUEL / ancienne gamme), formules et rituels RITUEL, calendrier, pause, fidélité.
// Sans réseau : Seal est simulé de façon réaliste (renumérotation après retrait, ligne inconnue ignorée).
process.env.SEAL_API_TOKEN = 'x';
process.env.KITS_CUSTOMER_SECRET = 'secret-test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const express = require('express');

const cfg = require('../core/kits/config');
const seal = require('../core/kits/seal');
const { swapRituel } = require('../core/kits/rituel');
const { changeFormula } = require('../core/kits/formula');
const ov = require('../core/portal/overview');
const actions = require('../core/portal/sealPortal');
const rewards = require('../core/rewards/engine');

const BN1 = '55290364723541', BN2 = '55290364756309', IC1 = '55290462470485', IC2 = '55290462503253';
const Z1 = '55725002883413', Z2 = '55725002916181', MEN = '55665971560789';
const OLD = '49000000000001';   // une variante de l'ancienne gamme

/* ---------------- Seal simulé ---------------- */
let SUB; let nextId; let calls; let ignoreAdd = false;
function reset(items, extra = {}) {
  nextId = 500; calls = []; ignoreAdd = false;
  SUB = { id: 9, email: 'a@b.fr', status: 'ACTIVE', delivery_interval: '1 month', billing_interval: '1 month', note_attributes: [], items, ...extra };
}
seal.getSubscription = async () => JSON.parse(JSON.stringify(SUB));
seal.findSubscriptionsByEmail = async () => [{ id: 9 }];
seal.editSubscription = async (id, e) => { calls.push(['freq', e.delivery_interval]); Object.assign(SUB, e); };
seal.editItems = async (id, items) => {
  calls.push(['edit']);
  for (const e of items) {
    const it = SUB.items.find((x) => x.id === Number(e.id));
    if (!it) continue;
    // Seal n'accepte pas de changer de produit sur place : seule la variante du même produit passe
    for (const k of ['quantity', 'price', 'variant_id', 'title', 'sku']) if (e[k] !== undefined) it[k] = k === 'quantity' ? Number(e[k]) : e[k];
  }
};
seal.addItems = async (id, items) => {
  calls.push(['add', ...items.map((i) => i.variant_id)]);
  if (ignoreAdd) return;
  items.forEach((i) => SUB.items.push({ id: nextId++, variant_id: String(i.variant_id), product_id: i.product_id, quantity: Number(i.quantity), price: i.price, title: i.title }));
};
seal.removeItems = async (id, ids) => {
  calls.push(['remove', ...ids]);
  SUB.items = SUB.items.filter((it) => !ids.map(Number).includes(it.id));
  SUB.items.forEach((it) => { it.id = nextId++; });
};
seal.upsertNotes = async (id, ups) => {
  calls.push(['notes', ...ups.map((u) => `${u.name}=${u.value}`)]);
  for (const u of ups) {
    const n = SUB.note_attributes.find((a) => a.name === u.name);
    if (n) n.value = u.value; else SUB.note_attributes.push({ ...u });
  }
};
const variants = () => SUB.items.filter((i) => i.quantity > 0).map((i) => i.variant_id);

/* ---------------- Gammes ---------------- */
test('gammes : reconnues par variante, prix RITUEL = prix ZÉRO', () => {
  assert.equal(cfg.rangeOf(Z2), 'zero');
  assert.equal(cfg.rangeOf(BN2), 'rituel');
  assert.equal(cfg.rangeOf(OLD), 'ancienne');
  assert.deepEqual(cfg.rituelOf(IC2), { code: 'IC', label: 'Idées Claires', months: 2, productId: '11688350056789', sku: 'POD-RIT-IC-24' });
  assert.equal(cfg.rituelVariant('PF', 3), '55290470728021');
  assert.deepEqual([1, 2, 3].map(cfg.priceForMonths), [49.9, 89.8, 119.7]);
  assert.equal(ov.gammeOf({ items: [{ variant_id: Z1, quantity: 1 }, { variant_id: MEN, quantity: 4 }] }), 'zero');
  assert.equal(ov.gammeOf({ items: [{ variant_id: BN1, quantity: 1 }] }), 'rituel');
  assert.equal(ov.gammeOf({ items: [{ variant_id: OLD, quantity: 1, title: 'PODS Recharge Bien-Être' }] }), 'ancienne');
  assert.equal(ov.formuleMois({ items: [{ variant_id: BN2, quantity: 1 }] }), 2);
  assert.equal(ov.formuleMois({ items: [{ variant_id: OLD, quantity: 1 }] }), null);
});

/* ---------------- RITUEL : formule et rituel ---------------- */
test('RITUEL : Bonnes Nuits 1 → 2 mois (rythme 2 mois, 89,80 €)', async () => {
  reset([{ id: 1, variant_id: BN1, product_id: '11688329871701', quantity: 1, price: '49.90' }]);
  const r = await swapRituel(await seal.getSubscription(9), BN2);
  assert.equal(r.changed, true);
  assert.deepEqual(variants(), [BN2]);
  assert.equal(SUB.delivery_interval, '2 month');
  assert.equal(SUB.items[0].price, '89.80');
});

test('RITUEL : changer de rituel (Bonnes Nuits → Idées Claires), même formule, même rythme', async () => {
  reset([{ id: 1, variant_id: BN1, product_id: '11688329871701', quantity: 1, price: '49.90' }]);
  await swapRituel(await seal.getSubscription(9), IC1);
  assert.deepEqual(variants(), [IC1]);
  assert.equal(SUB.delivery_interval, '1 month');
  assert.ok(!calls.some((c) => c[0] === 'freq'));   // le rythme n'a pas été touché
});

test('RITUEL : Seal refuse l\'ajout → erreur, rien n\'a changé (rythme remis)', async () => {
  reset([{ id: 1, variant_id: BN1, product_id: '11688329871701', quantity: 1, price: '49.90' }]);
  ignoreAdd = true;
  await assert.rejects(swapRituel(await seal.getSubscription(9), IC2));
  assert.deepEqual(variants(), [BN1]);
  assert.equal(SUB.delivery_interval, '1 month');
});

test('abonnement avec plusieurs produits : pas de changement de rythme en libre-service (RITUEL comme ZÉRO)', async () => {
  reset([
    { id: 1, variant_id: Z1, quantity: 1, price: '49.90' }, { id: 2, variant_id: MEN, quantity: 4, price: '0.00' },
    { id: 3, variant_id: BN1, quantity: 1, price: '49.90' },
  ]);
  await assert.rejects(swapRituel(await seal.getSubscription(9), BN2), /autres produits/);
  await assert.rejects(changeFormula(await seal.getSubscription(9), Z2), /autres produits/);
  assert.equal(SUB.delivery_interval, '1 month');
  // changer de rituel sans changer de formule reste possible
  await swapRituel(await seal.getSubscription(9), IC1);
  assert.ok(variants().includes(IC1) && !variants().includes(BN1));
});

/* ---------------- Pages : routes ---------------- */
function token(email) {
  const payload = Buffer.from(JSON.stringify({ c: 5, e: email, t: Math.floor(Date.now() / 1000) })).toString('base64url');
  return payload + '.' + crypto.createHmac('sha256', 'secret-test').update(payload).digest('hex');
}
async function call(app, method, path, body) {
  const srv = http.createServer(app).listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}${path}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token('a@b.fr') },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() };
  } finally { srv.close(); }
}

test('Mes saveurs : un abonné RITUEL voit sa formule et les 4 rituels, et peut changer ; l\'ancienne gamme n\'y est pas', async () => {
  const app = express(); app.use(express.json());
  app.use('/kits', require('../core/kits/flavorsApi'));
  reset([{ id: 1, variant_id: BN1, product_id: '11688329871701', quantity: 1, price: '49.90' }]);
  let r = await call(app, 'GET', '/kits/subscriptions');
  const v = r.json.subscriptions[0];
  assert.equal(v.kind, 'rituel');
  assert.equal(v.rituel.label, 'Bonnes Nuits');
  assert.deepEqual(v.formulas.map((f) => [f.months, f.price, f.current]), [[1, 49.9, true], [2, 89.8, false], [3, 119.7, false]]);
  assert.deepEqual(v.rituels.map((x) => x.code), ['BN', 'BE', 'IC', 'PF']);
  r = await call(app, 'POST', '/kits/subscriptions/9/rituel', { variantId: IC1 });
  assert.equal(r.status, 200);
  assert.equal(r.json.subscription.rituel.code, 'IC');
  r = await call(app, 'POST', '/kits/subscriptions/9/rituel', { variantId: Z2 });   // pas une variante RITUEL
  assert.equal(r.status, 400);
  reset([{ id: 1, variant_id: OLD, quantity: 1, price: '29.90' }]);
  r = await call(app, 'GET', '/kits/subscriptions');
  assert.deepEqual(r.json.subscriptions, []);
});

/* ---------------- Calendrier et pause ---------------- */
const dayFromNow = (n) => ov.addDays(ov.parisToday(), n);

test('calendrier et pause : fenêtre J+2 → date prévue +29 j, pause 1 ou 2 mois avec reprise automatique', async () => {
  const D = dayFromNow(20);
  const reschedules = [];
  actions.reschedule = async (id, att, date, time, tz, reset) => {
    reschedules.push({ date, time, reset });
    SUB.billing_attempts[0].date = `${date}T${time}:00+00:00`;
  };
  rewards.statusFor = async () => null;
  const app = express(); app.use(express.json());
  app.use('/kits/portal', require('../core/portal/portalApi'));
  reset([{ id: 1, variant_id: BN1, quantity: 1, price: '49.90' }], { billing_attempts: [{ id: 77, date: `${D}T11:00:00+00:00`, status: '', order_id: '', completed_at: '', skipped_on: null }] });

  // Vue : gamme, formule, fenêtre de dates
  let r = await call(app, 'GET', '/kits/portal/overview');
  let v = r.json.abonnements[0];
  assert.equal(v.gamme, 'rituel');
  assert.equal(v.formule_mois, 1);
  assert.deepEqual(v.dates_possibles, { min: dayFromNow(2), max: ov.addDays(D, 29) });
  assert.deepEqual(v.pause_mois, [1, 2]);

  // Date hors fenêtre : refusée ; dans la fenêtre : acceptée, heure gardée, calendrier recalculé
  r = await call(app, 'POST', '/kits/portal/9/date', { date: ov.addDays(D, 30) });
  assert.equal(r.status, 400);
  r = await call(app, 'POST', '/kits/portal/9/date', { date: dayFromNow(1) });
  assert.equal(r.status, 400);
  r = await call(app, 'POST', '/kits/portal/9/date', { date: ov.addDays(D, 10) });
  assert.equal(r.status, 200);
  assert.deepEqual(reschedules.pop(), { date: ov.addDays(D, 10), time: '11:00', reset: true });

  // Pause 3 mois : non proposée ; pause 2 mois : livraison repoussée, note posée, reprise affichée
  r = await call(app, 'POST', '/kits/portal/9/pause', { mois: 3 });
  assert.equal(r.status, 400);
  const avant = ov.addDays(D, 10);
  r = await call(app, 'POST', '/kits/portal/9/pause', { mois: 2 });
  assert.equal(r.status, 200);
  assert.deepEqual(reschedules.pop(), { date: ov.addMonths(avant, 2), time: '11:00', reset: true });
  assert.equal(SUB.status, 'ACTIVE');   // pas une pause Seal : l'abonnement reprend tout seul
  assert.deepEqual(r.json.abonnement.pause, { depuis: avant, jusqu_au: ov.addMonths(avant, 2) });

  // Reprendre plus tôt : retour à la date d'origine, note effacée
  r = await call(app, 'POST', '/kits/portal/9/fin-pause', {});
  assert.equal(r.status, 200);
  assert.equal(reschedules.pop().date, avant);
  assert.equal(r.json.abonnement.pause, null);
  r = await call(app, 'POST', '/kits/portal/9/fin-pause', {});
  assert.equal(r.status, 400);

  // Raccourci +7 pendant une pause : la pause est effacée (la date affichée reste vraie)
  await call(app, 'POST', '/kits/portal/9/pause', { mois: 1 });
  r = await call(app, 'POST', '/kits/portal/9/decaler', { jours: 7 });
  assert.equal(r.status, 200);
  assert.equal(r.json.abonnement.pause, null);
});

test('anciennes pauses Seal : jamais relancées automatiquement, « Reprendre » à la demande seulement', async () => {
  const resumed = [];
  actions.resume = async (id) => { resumed.push(id); SUB.status = 'ACTIVE'; };
  const app = express(); app.use(express.json());
  app.use('/kits/portal', require('../core/portal/portalApi'));
  reset([{ id: 1, variant_id: OLD, quantity: 1, price: '29.90' }], { status: 'PAUSED', billing_attempts: [] });
  let r = await call(app, 'GET', '/kits/portal/overview');
  assert.equal(r.json.abonnements[0].gamme, 'ancienne');
  assert.deepEqual(resumed, []);
  r = await call(app, 'POST', '/kits/portal/9/reprendre', {});
  assert.equal(r.status, 200);
  assert.deepEqual(resumed.map(String), ['9']);
});

/* ---------------- Fidélité : ancienneté toutes gammes ---------------- */
const ord = (id, date, variant, extra = {}) => ({
  id: `gid://shopify/Order/${id}`, createdAt: `${date}T10:00:00Z`, cancelledAt: null, tags: [], customAttributes: [],
  lineItems: { nodes: [{ quantity: 1, currentQuantity: 1, variant: { id: `gid://shopify/ProductVariant/${variant}`, title: '1 Mois' }, sellingPlan: { sellingPlanId: 'sp' } }] },
  ...extra,
});

test('fidélité : ancienneté du client, ZÉRO + RITUEL, sans additionner les abonnements en parallèle', () => {
  // ZÉRO et Bonnes Nuits pris en même temps pendant 2 mois → 2 mois d'ancienneté, pas 4
  const both = [ord(1, '2027-01-05', Z1), ord(2, '2027-01-05', BN1), ord(3, '2027-02-05', Z1), ord(4, '2027-02-05', BN1)];
  assert.equal(rewards.coveredMonths(both), 2);
  // Changer de rituel ne remet pas à zéro : Bonnes Nuits puis Idées Claires = 3 mois
  assert.equal(rewards.coveredMonths([ord(1, '2027-01-05', BN1), ord(2, '2027-02-05', BN1), ord(3, '2027-03-05', IC1)]), 3);
  // Une pause (trou) ne compte pas : janvier, puis avril → 2 mois
  assert.equal(rewards.coveredMonths([ord(1, '2027-01-05', Z1), ord(2, '2027-04-05', Z1)]), 2);
  // Formule 2 mois RITUEL : 2 mois dès le 1er colis ; février (28 j) compte bien pour un mois
  assert.equal(rewards.coveredMonths([ord(1, '2027-02-01', BN2)]), 2);
  assert.equal(rewards.coveredMonths([ord(1, '2027-02-01', Z1)]), 1);
  // Avant / après un colis
  const cur = ord(5, '2027-03-05', BN1);
  assert.equal(rewards.monthsBefore([...both, cur], cur), 2);
  assert.equal(rewards.monthsAfter([...both, cur], cur), 3);
});

test('fidélité : l\'ancienne gamme ne compte pas, sauf si REWARDS_ANCIENNE_GAMME=true', () => {
  const old = [ord(1, '2027-01-05', OLD), ord(2, '2027-02-05', OLD)];
  assert.equal(rewards.isSubscriptionDelivery(old[0]), false);
  assert.equal(rewards.coveredMonths(old.filter(rewards.isSubscriptionDelivery)), 0);
  process.env.REWARDS_ANCIENNE_GAMME = 'true';
  assert.equal(rewards.coveredMonths(old.filter(rewards.isSubscriptionDelivery)), 2);
  delete process.env.REWARDS_ANCIENNE_GAMME;
});
