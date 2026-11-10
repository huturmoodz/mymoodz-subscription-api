// Tests des briques kits, sans réseau : Shopify et Seal sont simulés.
// Lancer : node --test test/
process.env.KITS_LIVE = 'true';
process.env.KITS_CUSTOMER_SECRET = 'test-secret';
process.env.SEAL_API_TOKEN = 'x';
process.env.SHOPIFY_STORE_DOMAIN = 'test.myshopify.com';
process.env.SHOPIFY_KITS_ACCESS_TOKEN = 'x';
process.env.SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || 'whsec';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const C = require('../core/kits/composition');
const MEN = '55665971560789', CIT = '55665971593557', PAS = '55665971626325', FRA = '55665971659093';
const M1 = '52143295037781', M2 = '52143295070549', M3 = '52143295103317';

test('composition : lecture, total, refus des saveurs inconnues', () => {
  const m = C.parseComposition(`${MEN}:2,${CIT}:1,${PAS}:1, bad , ${CIT}:x`);
  assert.equal(C.totalOf(m), 4);
  assert.equal(C.validateComposition(m, 4).ok, true);
  assert.equal(C.validateComposition(m, 8).ok, false);
  assert.equal(C.validateComposition(C.parseComposition('123:4'), 4).ok, false);
  assert.equal(C.validateComposition(new Map(), 4).ok, false);
});

test('composition : changement de durée, proportions gardées', () => {
  const r = C.rescale(new Map([[MEN, 2], [CIT, 1], [PAS, 1]]), 8);
  assert.equal(C.totalOf(r), 8);
  assert.equal(r.get(MEN), 4);
  const r3 = C.rescale(new Map([[MEN, 1], [CIT, 1], [PAS, 1], [FRA, 1]]), 12);
  assert.deepEqual([...r3.values()], [3, 3, 3, 3]);
});

// ---------- Brique A : commande ----------
const shopify = require('../core/kits/shopify');
const calls = [];
let ORDER;
shopify.getOrder = async () => JSON.parse(JSON.stringify(ORDER));
shopify.holdFulfillmentOrder = async (id) => { calls.push(['hold', id]); ORDER.fulfillmentOrders.nodes.forEach((f) => f.id === id && f.fulfillmentHolds.push({ id: 'h1', handle: 'mmz-kit' })); };
shopify.releaseFulfillmentOrderHold = async (id) => { calls.push(['release', id]); ORDER.fulfillmentOrders.nodes.forEach((f) => (f.fulfillmentHolds = [])); };
shopify.addVariantsToOrder = async (id, adds) => { calls.push(['add', adds]); adds.forEach((a) => ORDER.lineItems.nodes.push({ id: 'n' + a.variantId, quantity: a.quantity, currentQuantity: a.quantity, variant: { id: `gid://shopify/ProductVariant/${a.variantId}` }, customAttributes: [] })); };
shopify.addTags = async (id, tags) => { calls.push(['tags', tags]); ORDER.tags.push(...tags); };
const { processOrder } = require('../core/kits/orderFlow');

const line = (variant, qty, compose) => ({
  id: 'l' + variant, quantity: qty, currentQuantity: qty,
  variant: { id: `gid://shopify/ProductVariant/${variant}` },
  customAttributes: compose ? [{ key: '_moodz_compose', value: compose }, { key: '_moodz_compose_id', value: 'c1' }] : [],
});
const order = (lines) => ({ id: 'gid://shopify/Order/1', name: '#1', tags: [], cancelledAt: null, displayFulfillmentStatus: 'UNFULFILLED',
  lineItems: { nodes: lines }, fulfillmentOrders: { nodes: [{ id: 'fo1', status: 'OPEN', fulfillmentHolds: [] }] } });

test('A : recharge 2 mois composée → attente, 8 boîtes ajoutées, libération, tag ok', async () => {
  calls.length = 0;
  ORDER = order([line(M2, 1, `${MEN}:4,${CIT}:2,${FRA}:2`)]);
  const r = await processOrder('1');
  assert.equal(r.done, true);
  assert.deepEqual(calls.map((c) => c[0]), ['hold', 'add', 'release', 'tags']);
  const added = Object.fromEntries(calls[1][1].map((a) => [a.variantId, a.quantity]));
  assert.deepEqual(added, { [MEN]: 4, [CIT]: 2, [FRA]: 2 });
});

test('A : rejouer la même commande ne rajoute rien (idempotent)', async () => {
  calls.length = 0;
  const r = await processOrder('1');
  assert.equal(r.done, true);
  assert.equal(calls.filter((c) => c[0] === 'add').length, 0);
});

test('A : composition trafiquée (12 boîtes pour 1 mois) → bloquée + tag erreur, rien ajouté', async () => {
  calls.length = 0;
  ORDER = order([line(M1, 1, `${MEN}:12`)]);
  const r = await processOrder('1');
  assert.equal(r.error, true);
  assert.deepEqual(calls.map((c) => c[0]), ['hold', 'tags']);
  assert.deepEqual(calls[1][1], ['mmz-kit-erreur']);
});

test('A : upsell post-achat sans composition → reprend les proportions de la recharge principale', async () => {
  calls.length = 0;
  ORDER = order([line(M1, 1, `${MEN}:2,${CIT}:2`), line(M1, 1, null)]);
  const r = await processOrder('1');
  assert.equal(r.done, true);
  const added = Object.fromEntries(calls.find((c) => c[0] === 'add')[1].map((a) => [a.variantId, a.quantity]));
  assert.deepEqual(added, { [MEN]: 4, [CIT]: 4 });
});

test('A : ancienne gamme (pas de composition) → aucune action', async () => {
  calls.length = 0;
  ORDER = order([line(M1, 1, null)]);
  const r = await processOrder('1');
  assert.equal(r.skipped, true);
  assert.equal(calls.length, 0);
});

// ---------- Abonnement Seal ----------
const seal = require('../core/kits/seal');
let SUB; const sealCalls = [];
seal.getSubscription = async () => JSON.parse(JSON.stringify(SUB));
seal.addItems = async (id, items) => { sealCalls.push(['add', items]); items.forEach((it, i) => SUB.items.push({ id: 900 + SUB.items.length + i, variant_id: it.variant_id, quantity: Number(it.quantity) })); };
seal.removeItems = async (id, ids) => { sealCalls.push(['remove', ids]); SUB.items = SUB.items.filter((it) => !ids.includes(it.id)); };
seal.editItems = async (id, items) => { sealCalls.push(['edit', items]); items.forEach((e) => { const it = SUB.items.find((x) => x.id === e.id); it.quantity = Number(e.quantity); }); };
seal.upsertNotes = async (id, ups) => { sealCalls.push(['notes', ups]); ups.forEach((u) => { const n = SUB.note_attributes.find((a) => a.name === u.name); if (n) n.value = u.value; else SUB.note_attributes.push({ ...u }); }); };
const { syncSubscription } = require('../core/kits/subscriptionKit');

test('Seal : abonnement créé → les 4 boîtes entrent dans le contrat, une seule fois', async () => {
  sealCalls.length = 0;
  SUB = { id: 10, email: 'hugo@x.fr', note_attributes: [], items: [{ id: 1, variant_id: M1, quantity: 1, properties: [{ key: '_moodz_compose', value: `${CIT}:4` }] }] };
  await syncSubscription(10);
  assert.deepEqual(sealCalls.map((c) => c[0]), ['add', 'notes']);
  sealCalls.length = 0;
  await syncSubscription(10); // le webhook « modifié » qui suit ne doit rien refaire
  assert.equal(sealCalls.length, 0);
});

test('Seal : passage 1 → 2 mois dans l’espace client → 8 boîtes, mêmes proportions', async () => {
  sealCalls.length = 0;
  SUB.items[0].variant_id = M2;
  await syncSubscription(10);
  const boxes = SUB.items.filter((it) => it.variant_id === CIT);
  assert.equal(boxes.reduce((s, b) => s + b.quantity, 0), 8);
});

// ---------- Brique B : jeton client ----------
const { verifyCustomerToken } = require('../core/kits/customerAuth');
const mk = (obj, secret = 'test-secret') => {
  const p = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return p + '.' + crypto.createHmac('sha256', secret).update(p).digest('hex');
};
test('B : jeton valide accepté, falsifié ou périmé refusé', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.deepEqual(verifyCustomerToken(mk({ c: 42, e: 'Hugo@X.fr', t: now })), { customerId: '42', email: 'hugo@x.fr' });
  assert.equal(verifyCustomerToken(mk({ c: 42, e: 'hugo@x.fr', t: now }, 'autre')), null);
  assert.equal(verifyCustomerToken(mk({ c: 42, e: 'hugo@x.fr', t: now - 7 * 3600 })), null);
  assert.equal(verifyCustomerToken('n.importe.quoi'), null);
});

// ---------- Attente posée par Flow + clôture de la ligne Recharge ----------
test('A : attente posée par Flow (note MMZ-KIT) reconnue et levée, ligne Recharge clôturée', async () => {
  calls.length = 0;
  shopify.fulfillWithoutShipping = async (id) => calls.push(['close', id]);
  ORDER = order([line(M1, 1, `${CIT}:4`)]);
  ORDER.fulfillmentOrders.nodes = [
    { id: 'foParent', status: 'OPEN', fulfillmentHolds: [{ id: 'hf', handle: null, reasonNotes: 'MMZ-KIT attente boîtes' }],
      lineItems: { nodes: [{ id: 'x', remainingQuantity: 1, lineItem: { variant: { id: `gid://shopify/ProductVariant/${M1}` } } }] } },
  ];
  const r = await processOrder('1');
  assert.equal(r.done, true);
  const kinds = calls.map((c) => c[0]);
  assert.ok(!kinds.includes('hold'), 'pas de seconde attente si Flow en a déjà posé une');
  assert.ok(kinds.includes('release'));
  assert.ok(kinds.includes('close'));
});

test('A : commande sans kit mais attente Flow → attente levée (aucune commande bloquée par erreur)', async () => {
  calls.length = 0;
  ORDER = order([line(M1, 1, null)]);
  ORDER.fulfillmentOrders.nodes[0].fulfillmentHolds = [{ id: 'hf', handle: null, reasonNotes: 'MMZ-KIT' }];
  const r = await processOrder('1');
  assert.equal(r.released, true);
  assert.deepEqual(calls.map((c) => c[0]), ['release']);
});

test('A : une attente posée par quelqu’un d’autre n’est jamais levée', async () => {
  calls.length = 0;
  ORDER = order([line(M1, 1, null)]);
  ORDER.fulfillmentOrders.nodes[0].fulfillmentHolds = [{ id: 'hx', handle: 'fraude', reasonNotes: 'Vérification' }];
  const r = await processOrder('1');
  assert.equal(r.released, false);
  assert.equal(calls.length, 0);
});
