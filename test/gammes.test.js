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

/*
 * Calendrier Seal simulé, avec ses vraies règles (constatées le 13/11 sur un abonnement test) :
 * deux livraisons ne peuvent pas tomber le même jour (même avec reset_schedule) ; reset_schedule
 * supprime les livraisons non traitées qui suivent et les recrée à partir de la nouvelle date.
 */
let attemptId = 1000;
const att = (day) => ({ id: attemptId++, date: `${day}T11:00:00+00:00`, status: '', order_id: '', completed_at: '', skipped_on: null });
const months = () => parseInt(SUB.delivery_interval, 10);
const opsLog = [];
let failOn = null;   // { type, n } : la n-ième action de ce type échoue
function failIf(type) {
  if (failOn && failOn.type === type && --failOn.n === 0) { failOn = null; throw new Error('Seal indisponible'); }
}
actions.skip = async (id, aid) => { failIf('skip'); opsLog.push(['skip', String(aid)]); SUB.billing_attempts.find((a) => String(a.id) === String(aid)).skipped_on = ov.parisToday(); };
actions.unskip = async (id, aid) => { failIf('unskip'); opsLog.push(['unskip', String(aid)]); SUB.billing_attempts.find((a) => String(a.id) === String(aid)).skipped_on = null; };
actions.reschedule = async (id, aid, date, time, tz, reset) => {
  failIf('move');
  const a = SUB.billing_attempts.find((x) => String(x.id) === String(aid));
  if (SUB.billing_attempts.some((x) => x !== a && x.date.slice(0, 10) === date)) {
    throw new Error("Couldn't reschedule billing attempt. There is already another attempt scheduled close to the desired date.");
  }
  opsLog.push(['move', String(aid), date, reset]);
  a.date = `${date}T${time}:00+00:00`;
  if (reset) {
    SUB.billing_attempts = SUB.billing_attempts.filter((x) => x === a || x.date < a.date);
    for (let k = 1; k <= 3; k++) SUB.billing_attempts.push(att(ov.addMonths(date, k * months())));
  }
};
function schedule(variant, every, firstDay, n = 4, extra = {}) {
  reset([{ id: 1, variant_id: variant, quantity: 1, price: '49.90' }], {
    delivery_interval: `${every} month`, billing_interval: `${every} month`,
    billing_attempts: Array.from({ length: n }, (_, k) => att(ov.addMonths(firstDay, k * every))), ...extra,
  });
  opsLog.length = 0;
}
const portalApp = () => {
  rewards.statusFor = async () => null;
  const app = express(); app.use(express.json());
  app.use('/kits/portal', require('../core/portal/portalApi'));
  return app;
};
const days = () => SUB.billing_attempts.map((a) => a.date.slice(0, 10) + (a.skipped_on ? ' (sautée)' : ''));

test('calendrier : fenêtre J+2 → date prévue +29 j, jamais le jour de la livraison suivante', async () => {
  const app = portalApp();
  const D = dayFromNow(20);
  schedule(BN1, 1, D);
  let v = (await call(app, 'GET', '/kits/portal/overview')).json.abonnements[0];
  assert.equal(v.gamme, 'rituel');
  assert.equal(v.formule_mois, 1);
  const eve = ov.addDays(ov.addMonths(D, 1), -1);
  assert.deepEqual(v.dates_possibles, { min: dayFromNow(2), max: [ov.addDays(D, 29), eve].sort()[0] });
  assert.deepEqual(v.pause_mois, [1, 2]);

  let r = await call(app, 'POST', '/kits/portal/9/date', { date: ov.addMonths(D, 1) });   // jour de la suivante
  assert.equal(r.status, 400);
  r = await call(app, 'POST', '/kits/portal/9/date', { date: dayFromNow(1) });
  assert.equal(r.status, 400);
  r = await call(app, 'POST', '/kits/portal/9/date', { date: ov.addDays(D, 10) });
  assert.equal(r.status, 200);
  assert.deepEqual(opsLog.pop(), ['move', String(SUB.billing_attempts[0].id), ov.addDays(D, 10), true]);
  assert.equal(r.json.abonnement.prochaine_livraison.date.slice(0, 10), ov.addDays(D, 10));
  assert.equal(SUB.billing_attempts[1].date.slice(0, 10), ov.addMonths(ov.addDays(D, 10), 1));   // les suivantes repartent de là
});

test('pause d\'un abonnement mensuel : on saute jusqu\'à la livraison de reprise (rien à déplacer), puis on la défait', async () => {
  const app = portalApp();
  const D = dayFromNow(20);
  schedule(Z1, 1, D);
  const [a1, a2] = SUB.billing_attempts.map((a) => String(a.id));

  let r = await call(app, 'POST', '/kits/portal/9/pause', { mois: 3 });
  assert.equal(r.status, 400);
  r = await call(app, 'POST', '/kits/portal/9/pause', { mois: 1 });
  assert.equal(r.status, 200);
  assert.deepEqual(opsLog, [['skip', a1]]);
  assert.equal(SUB.status, 'ACTIVE');   // pas une pause Seal : l'abonnement reprend tout seul
  let v = r.json.abonnement;
  assert.deepEqual(v.pause, { depuis: D, jusqu_au: ov.addMonths(D, 1) });
  assert.deepEqual(v.prochaine_livraison, { id: a2, date: SUB.billing_attempts[1].date, skipped: false });
  assert.equal(v.dates_possibles, null);

  // Pendant la pause : pas de décalage, de saut, ni de livraison immédiate
  for (const [path, body] of [['decaler', { jours: 7 }], ['date', { date: ov.addDays(D, 3) }], ['sauter', {}], ['recevoir-maintenant', {}], ['pause', { mois: 1 }]]) {
    r = await call(app, 'POST', `/kits/portal/9/${path}`, body);
    assert.equal(r.status, 400, path);
  }

  // Reprendre plus tôt : la livraison sautée revient
  opsLog.length = 0;
  r = await call(app, 'POST', '/kits/portal/9/fin-pause', {});
  assert.equal(r.status, 200);
  assert.deepEqual(opsLog, [['unskip', a1]]);
  assert.equal(r.json.abonnement.pause, null);
  assert.equal(r.json.abonnement.prochaine_livraison.date.slice(0, 10), D);
  r = await call(app, 'POST', '/kits/portal/9/fin-pause', {});
  assert.equal(r.status, 400);

  // 2 mois : deux livraisons sautées, reprise sur la 3e ; reprise anticipée = les deux reviennent
  opsLog.length = 0;
  r = await call(app, 'POST', '/kits/portal/9/pause', { mois: 2 });
  assert.equal(r.status, 200);
  assert.deepEqual(opsLog, [['skip', a1], ['skip', a2]]);
  assert.equal(r.json.abonnement.pause.jusqu_au, ov.addMonths(D, 2));
  r = await call(app, 'POST', '/kits/portal/9/fin-pause', {});
  assert.deepEqual(days().slice(0, 2), [D, ov.addMonths(D, 1)]);
});

test('pause d\'une formule 2 mois : la livraison est reportée à la reprise, puis remise à sa date', async () => {
  const app = portalApp();
  const D = dayFromNow(20);
  schedule(BN2, 2, D, 3);
  const a1 = String(SUB.billing_attempts[0].id);
  let r = await call(app, 'POST', '/kits/portal/9/pause', { mois: 1 });
  assert.equal(r.status, 200);
  assert.deepEqual(opsLog, [['move', a1, ov.addMonths(D, 1), true]]);
  assert.deepEqual(r.json.abonnement.pause, { depuis: D, jusqu_au: ov.addMonths(D, 1) });
  assert.equal(r.json.abonnement.prochaine_livraison.id, a1);

  r = await call(app, 'POST', '/kits/portal/9/fin-pause', {});
  assert.equal(r.status, 200);
  assert.equal(r.json.abonnement.pause, null);
  assert.deepEqual(days().slice(0, 2), [D, ov.addMonths(D, 2)]);

  // Pause 2 mois sur une formule 2 mois : la livraison suivante tombe pile → on saute
  opsLog.length = 0;
  r = await call(app, 'POST', '/kits/portal/9/pause', { mois: 2 });
  assert.deepEqual(opsLog.map((o) => o[0]), ['skip']);
  assert.equal(r.json.abonnement.pause.jusqu_au, ov.addMonths(D, 2));
});

test('pause : si Seal échoue en cours de route, tout est remis comme avant (ni note, ni livraison sautée)', async () => {
  const app = portalApp();
  const D = dayFromNow(20);
  schedule(Z1, 1, D);
  const before = days();
  failOn = { type: 'skip', n: 2 };   // la 2e livraison ne peut pas être sautée
  let r = await call(app, 'POST', '/kits/portal/9/pause', { mois: 2 });
  assert.equal(r.status, 502);
  assert.deepEqual(days(), before);
  assert.equal(seal.getNote(SUB, ov.PAUSE_NOTE), '');

  // La note ne peut pas être écrite : la livraison sautée est remise
  const write = seal.upsertNotes;
  seal.upsertNotes = async () => { throw new Error('Seal indisponible'); };
  r = await call(app, 'POST', '/kits/portal/9/pause', { mois: 1 });
  seal.upsertNotes = write;
  assert.equal(r.status, 502);
  assert.deepEqual(days(), before);
});

test('reprendre plus tôt quand la livraison sautée est déjà (presque) passée : reprise au plus tôt, J+2', async () => {
  const app = portalApp();
  const D = dayFromNow(1);   // trop proche pour être reprise
  schedule(Z1, 1, D);
  let r = await call(app, 'POST', '/kits/portal/9/pause', { mois: 1 });
  assert.equal(r.status, 200);
  opsLog.length = 0;
  r = await call(app, 'POST', '/kits/portal/9/fin-pause', {});
  assert.equal(r.status, 200);
  assert.deepEqual(opsLog.map((o) => o.slice(0, 3)), [['move', String(SUB.billing_attempts[1].id), dayFromNow(2)]]);
  const v = r.json.abonnement;
  assert.equal(v.pause, null);
  // La livraison de demain reste sautée (affichée comme telle), la vraie prochaine est à J+2
  assert.deepEqual([v.prochaine_livraison.skipped, v.prochaine_livraison.suivante.slice(0, 10)], [true, dayFromNow(2)]);
});

test('une livraison sautée dont la date est passée n\'est plus « la prochaine »', () => {
  schedule(Z1, 1, dayFromNow(-3));
  SUB.billing_attempts[0].skipped_on = dayFromNow(-5);
  assert.equal(ov.nextAttempt(SUB).date.slice(0, 10), ov.addMonths(dayFromNow(-3), 1));
});

test('note de pause : ancienne forme « origine|reprise » toujours lue', () => {
  const D = dayFromNow(20);
  schedule(Z1, 1, D);
  SUB.note_attributes = [{ name: ov.PAUSE_NOTE, value: `${dayFromNow(-10)}|${D}` }];
  assert.deepEqual(ov.pauseOf(SUB).jusqu_au, D);
  SUB.note_attributes = [{ name: ov.PAUSE_NOTE, value: '' }];
  assert.equal(ov.pauseOf(SUB), null);
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
